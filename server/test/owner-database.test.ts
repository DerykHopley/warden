// Outside CI, the server's tests and the browser tests refuse the owner's compose Postgres (port 54329) unless asked
// for (#286). Each command runs against a stand-in Postgres on a Unix socket for port 54329 in a folder of its own
// (`socketPostgres`), with only PATH and HOME from this run's environment, so CI is unset there; a guard that let it
// through would reach the stand-in, never the owner's database.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "./child-process.ts";
import { refuseOwnerDatabase } from "./owner-database.ts";
import { socketPostgres } from "./ports.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Runs `pnpm <args>` from the repo root with only `env` (plus PATH and HOME), to the end. */
function pnpm(args: string[], env: Record<string, string>) {
  return runCommand(["pnpm", ...args], env, { cwd: repoRoot, clean: true });
}

describe("refuseOwnerDatabase", () => {
  it("refuses port 54329 outside CI, naming the port, a throwaway Postgres and the opt-in", () => {
    expect(() => refuseOwnerDatabase("54329", "pnpm e2e", {})).toThrow(
      /port 54329[\s\S]*docker run [\s\S]*pgvector\/pgvector:pg17[\s\S]*PGPORT=55432 pnpm e2e[\s\S]*WARDEN_TEST_OWNER_DB=1/,
    );
  });

  it("refuses port 54329 when WARDEN_TEST_OWNER_DB is anything but 1", () => {
    for (const value of ["", "0", "true"])
      expect(() =>
        refuseOwnerDatabase("54329", "pnpm e2e", { WARDEN_TEST_OWNER_DB: value }),
      ).toThrow(/port 54329/);
  });

  it("lets port 54329 through with WARDEN_TEST_OWNER_DB=1", () => {
    expect(() =>
      refuseOwnerDatabase("54329", "pnpm e2e", { WARDEN_TEST_OWNER_DB: "1" }),
    ).not.toThrow();
  });

  it("lets port 54329 through in CI", () => {
    expect(() => refuseOwnerDatabase("54329", "pnpm e2e", { CI: "true" })).not.toThrow();
  });

  it("lets any other port through", () => {
    expect(() => refuseOwnerDatabase("55432", "pnpm e2e", {})).not.toThrow();
  });
});

describe.each([
  { command: "the server's tests", args: ["--filter", "@warden/server", "test"] },
  { command: "the browser tests", args: ["e2e"] },
])("$command, outside CI", ({ args }) => {
  let postgres: Awaited<ReturnType<typeof socketPostgres>>;
  beforeEach(async () => {
    postgres = await socketPostgres("54329");
  });
  afterEach(() => postgres.close());

  it("exit non-zero with PGPORT unset, naming the port and the fix, before any login", async () => {
    const { code, output } = await pnpm(args, { PGHOST: postgres.host });

    expect(code).not.toBe(0);
    expect(output).toMatch(/won't run against port 54329[\s\S]*WARDEN_TEST_OWNER_DB=1/);
    expect(postgres.logins()).toBe(0);
  }, 60_000);

  it("go on to the database on port 54329 with WARDEN_TEST_OWNER_DB=1", async () => {
    const { output } = await pnpm(args, {
      PGHOST: postgres.host,
      PGPORT: "54329",
      WARDEN_TEST_OWNER_DB: "1",
    });

    expect(output).not.toMatch(/won't run against port/);
    expect(postgres.logins()).toBeGreaterThan(0);
  }, 60_000);
});
