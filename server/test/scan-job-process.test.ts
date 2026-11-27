// The Scan Job's entry point as its own process (ADR 0009): it takes its Scan from WARDEN_SCAN_ID and WARDEN_TEAM,
// and connects as the app role with the server's role check, needing no Clerk variable and no admin password.
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { runInServer } from "./databases.ts";
import { closedPort } from "./ports.ts";
import { logEntries } from "./helpers.ts";

/** The Job as its own process, on the suite's shared database as warden_app unless `env` says otherwise. */
function runJob(env: Record<string, string>) {
  return runInServer([process.execPath, "src/scan-job.ts"], {
    PGDATABASE: inject("testDatabase"),
    PGUSER: "warden_app",
    ...env,
  });
}

describe("the Scan Job's process", () => {
  it.each([
    ["WARDEN_SCAN_ID missing", { WARDEN_TEAM: "org_a" }, "WARDEN_SCAN_ID"],
    ["WARDEN_SCAN_ID blank", { WARDEN_TEAM: "org_a", WARDEN_SCAN_ID: "  " }, "WARDEN_SCAN_ID"],
    ["WARDEN_TEAM missing", { WARDEN_SCAN_ID: "scan-1" }, "WARDEN_TEAM"],
    ["WARDEN_TEAM blank", { WARDEN_SCAN_ID: "scan-1", WARDEN_TEAM: "" }, "WARDEN_TEAM"],
  ])("exits 1 before connecting with %s", async (_name, env, named) => {
    const { code, output } = await runJob({
      ...env,
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(code, output).toBe(1);
    expect(output).toContain(named);
    expect(output).not.toMatch(/ECONNREFUSED/);
  });

  it("exits 1 before connecting with GITHUB_APP_CLIENT_ID set alone, naming GITHUB_APP_PRIVATE_KEY", async () => {
    const { code, output } = await runJob({
      WARDEN_SCAN_ID: randomUUID(),
      WARDEN_TEAM: "org_a",
      GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
      // Empty counts as unset, whatever the shell running the tests holds.
      GITHUB_APP_PRIVATE_KEY: "",
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(code, output).toBe(1);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({ severity: "ERROR", variables: ["GITHUB_APP_PRIVATE_KEY"] }),
    );
    expect(output).not.toContain("Iv23li-client-id-value");
    expect(output).not.toMatch(/ECONNREFUSED/);
  });

  it.each([
    [
      "both WARDEN_SCAN_ID and WARDEN_SESSION_ID set",
      { WARDEN_SCAN_ID: "scan-value-1", WARDEN_SESSION_ID: "sess-value-1" },
      ["WARDEN_SCAN_ID", "WARDEN_SESSION_ID"],
      ["scan-value-1", "sess-value-1"],
    ],
    [
      "a WARDEN_SESSION_ID outside the session pattern",
      { WARDEN_SESSION_ID: "sess value/../1" },
      ["WARDEN_SESSION_ID"],
      ["sess value/../1"],
    ],
    [
      "a WARDEN_SESSION_ID past 128 characters",
      { WARDEN_SESSION_ID: "s".repeat(129) },
      ["WARDEN_SESSION_ID"],
      ["s".repeat(129)],
    ],
    [
      "a Judge run's WARDEN_JUDGE_LOCALHOST that isn't 1",
      { WARDEN_SESSION_ID: "sess-value-1", WARDEN_JUDGE_LOCALHOST: "localhost-please" },
      ["WARDEN_JUDGE_LOCALHOST"],
      ["localhost-please"],
    ],
    [
      "a Judge run's LANGFUSE_PUBLIC_KEY without LANGFUSE_SECRET_KEY",
      // Empty counts as unset, whatever the shell running the tests holds.
      {
        WARDEN_SESSION_ID: "sess-value-1",
        LANGFUSE_PUBLIC_KEY: "pk-lf-value-1",
        LANGFUSE_SECRET_KEY: "",
      },
      ["LANGFUSE_SECRET_KEY"],
      ["pk-lf-value-1"],
    ],
    [
      "a Judge run's LANGFUSE_BASE_URL that isn't https",
      {
        WARDEN_SESSION_ID: "sess-value-1",
        LANGFUSE_PUBLIC_KEY: "pk-lf-value-1",
        LANGFUSE_SECRET_KEY: "sk-lf-value-1",
        LANGFUSE_BASE_URL: "http://langfuse.example",
      },
      ["LANGFUSE_BASE_URL"],
      ["pk-lf-value-1", "sk-lf-value-1", "http://langfuse.example"],
    ],
  ])(
    "exits 1 before connecting with %s, naming the variables and no value",
    async (_name, env, variables, values) => {
      const { code, output } = await runJob({
        WARDEN_TEAM: "org_a",
        ...env,
        PGHOST: "127.0.0.1",
        PGPORT: String(await closedPort()),
      });

      expect(code, output).toBe(1);
      expect(logEntries(output)).toContainEqual(
        expect.objectContaining({ severity: "ERROR", variables }),
      );
      for (const value of values) expect(output).not.toContain(value);
      expect(output).not.toMatch(/ECONNREFUSED/);
    },
  );

  it("runs a Judge run for WARDEN_SESSION_ID as the app role, exiting 0 for a session the Team doesn't have", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const { code, output } = await runJob({
      WARDEN_SESSION_ID: sessionId,
      WARDEN_TEAM: "org_scan_process",
      // Nothing to judge, so no key is needed and no call is made.
      OPENROUTER_API_KEY: "",
    });

    expect(code, output).toBe(0);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({
        severity: "INFO",
        message: expect.stringContaining("nothing to judge"),
        team: "org_scan_process",
      }),
    );
  });

  it("exits 1 naming the role when PGUSER can bypass row-level security", async () => {
    const { code, output } = await runJob({
      PGUSER: "warden_migrate",
      WARDEN_SCAN_ID: randomUUID(),
      WARDEN_TEAM: "org_scan_process",
    });

    expect(code, output).toBe(1);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({ severity: "ERROR", role: "warden_migrate" }),
    );
  });

  it("connects as the app role, with no Clerk variable, and exits 1 for a Scan the Team doesn't have", async () => {
    const scanId = randomUUID();
    const { code, output } = await runJob({
      WARDEN_SCAN_ID: scanId,
      WARDEN_TEAM: "org_scan_process",
    });

    expect(code, output).toBe(1);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        message: expect.stringContaining("no such Scan"),
        scanId,
        team: "org_scan_process",
      }),
    );
  });
});
