// @vitest-environment node
// The browser tests' Clerk stand-in goes only into the `e2e` mode's build: a production build holds none of it. Each
// build goes to a throwaway folder, and its JavaScript is searched for the stand-in's marker.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";

const MARKER = "WARDEN_E2E_CLERK_STAND_IN";
const root = fileURLToPath(new URL("..", import.meta.url));
const outDirs: string[] = [];

afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Builds the dashboard in `mode` and returns every built file's text. */
async function built(mode: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), `warden-dashboard-${mode}-`));
  outDirs.push(outDir);
  await build({ root, mode, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  const files = readdirSync(outDir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
  return files.map((file) => readFileSync(join(file.parentPath, file.name), "utf8")).join("\n");
}

describe("the Clerk stand-in", () => {
  it("is in the e2e mode's build, so the search below can find it", async () => {
    expect(await built("e2e")).toContain(MARKER);
  }, 60_000);

  it("is in no part of a production build", async () => {
    // A placeholder key: the production build needs one, and its value doesn't matter here.
    vi.stubEnv(
      "VITE_CLERK_PUBLISHABLE_KEY",
      "pk_test_Y2ktcGxhY2Vob2xkZXIuY2xlcmsuYWNjb3VudHMuZGV2JA",
    );
    const production = await built("production");
    expect(production).not.toContain(MARKER);
    expect(production).not.toContain("__WARDEN_E2E_SESSION__");
  }, 60_000);
});
