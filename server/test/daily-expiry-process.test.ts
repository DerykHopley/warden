// The daily Job's entry point as its own process (ADR 0009), on a fresh migrated database of this file's own: as
// warden_app, with warden_admin listing the Teams, it reopens an expired acceptance in each of two Teams. Refused
// before anything changes: an admin connection that isn't the admin role, an app role that can get around row-level
// security, a database that can't be reached. The refusals run first; the run that changes rows runs last.
import { fingerprint, type Finding } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createMigratedTestDatabase, poolAs, runInServer } from "./databases.ts";
import { closedPort } from "./ports.ts";
import { logEntries } from "./server-process.ts";

const TEAMS = ["org_job_a", "org_job_b"];
const ends: (() => Promise<unknown>)[] = [];
let database: string;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(async () => {
  const made = await createMigratedTestDatabase();
  ends.push(made.drop);
  database = made.name;
  const app: pg.Pool = poolAs("warden_app", database);
  ends.push(() => app.end());
  withTeam = createWithTeam(app);
  findings = createFindings({ withTeam, moveRules: {} });
  for (const [i, team] of TEAMS.entries()) {
    const location = { kind: "file", path: ".claude/settings.json" } as const;
    const finding: Finding = {
      id: `f-${i}`,
      team,
      asset: { kind: "repo", ref: "https://github.com/example/app" },
      module: "guard",
      rule_id: "guard/agent-can-read-env",
      fingerprint: fingerprint("guard/agent-can-read-env", location),
      location,
      severity: "high",
      title: "The agent can read .env files",
      evidence: { summary: "permissions.allow lets the agent read .env" },
      status: "accepted",
      unconfirmed_fix: null,
      accepted_reason: "Fixed next sprint",
      accepted_until: "2026-01-01T00:00:00Z",
      first_seen_scan: "scan-0",
      last_seen_scan: "scan-0",
      moved_to: null,
    };
    await withTeam(team, async (tx) => {
      await tx.insertInto("teams").values({ id: team }).execute();
      await tx.insertInto("findings").values(toRow(finding)).execute();
    });
  }
}, 30_000);

afterAll(async () => {
  for (const end of ends.splice(0).reverse()) await end();
}, 30_000);

/** The Job as its own process, on this file's database as warden_app unless `env` says otherwise. */
function runJob(env: Record<string, string> = {}) {
  return runInServer([process.execPath, "src/daily-expiry.ts"], {
    PGDATABASE: database,
    PGUSER: "warden_app",
    ...env,
  });
}

const everyStatus = async () =>
  Promise.all(TEAMS.map(async (team) => (await findings.list(team)).map((f) => f.status)));

const errorLine = (output: string) => logEntries(output).find((e) => e.severity === "ERROR");

describe("the daily Job's process", () => {
  it("exits 1 naming the role when the admin connection isn't the set's admin role, and changes nothing", async () => {
    const { code, output } = await runJob({ WARDEN_ADMIN_USER: "warden_app" });

    expect(code, output).toBe(1);
    expect(JSON.stringify(errorLine(output))).toContain(
      "the admin connection is warden_app, not warden_admin",
    );
    expect(await everyStatus()).toEqual([["accepted"], ["accepted"]]);
  });

  it("exits 1 naming the role and the reason when PGUSER can bypass row-level security, and changes nothing", async () => {
    const { code, output } = await runJob({ PGUSER: "warden_migrate" });

    expect(code, output).toBe(1);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        role: "warden_migrate",
        reason: expect.stringMatching(
          /^warden_migrate (owns a table in public|is the migration role)/,
        ),
      }),
    );
    expect(await everyStatus()).toEqual([["accepted"], ["accepted"]]);
  });

  it("exits 1 for a WARDEN_DATABASE_ROLES it doesn't know, before connecting", async () => {
    const { code, output } = await runJob({
      WARDEN_DATABASE_ROLES: "staging",
      PGPORT: String(await closedPort()),
    });

    expect(code, output).toBe(1);
    expect(output).toContain("WARDEN_DATABASE_ROLES");
    expect(output).not.toMatch(/ECONNREFUSED/);
  });

  it("exits 1 and logs the error when the database can't be reached", async () => {
    const { code, output } = await runJob({
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(code, output).toBe(1);
    expect(errorLine(output)).toMatchObject({
      message: "daily expiry failed; nothing was changed",
      error: expect.objectContaining({ code: "ECONNREFUSED" }),
    });
  });

  it("reopens the expired acceptance in each of two Teams, and exits 0", async () => {
    const { code, output } = await runJob();

    expect(code, output).toBe(0);
    expect(await everyStatus()).toEqual([["open"], ["open"]]);
    expect(logEntries(output).at(-1)).toMatchObject({
      message: "daily expiry done",
      teamsVisited: 2,
      teamsFailed: 0,
      findingsReopened: 2,
    });
  });
});
