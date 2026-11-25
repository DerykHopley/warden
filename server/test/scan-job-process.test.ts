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
