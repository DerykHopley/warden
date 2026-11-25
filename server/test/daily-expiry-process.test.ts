// The daily Job's entry point as its own process (ADR 0009), on a fresh migrated database of this file's own with the
// CVE snapshot loaded: as warden_app, with warden_admin listing the Teams, it reopens an expired acceptance in each of
// two Teams and runs Patch's daily step, one Patch Scan per Product (story 7). Refused before anything changes: an app
// password with no admin password beside it, an app role that can get around row-level security, a database that
// can't be reached. The refusals run first; the runs that change rows run last, in order.
import { fingerprint, type Finding } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { PATCH_RULE } from "../src/modules/patch/scan.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import {
  createMigratedTestDatabase,
  loadTestCveSnapshot,
  poolAs,
  runInServer,
} from "./databases.ts";
import { seedPatchFinding, seedProduct } from "./helpers.ts";
import { closedPort } from "./ports.ts";
import { logEntries } from "./helpers.ts";

const TEAMS = ["org_job_a", "org_job_b"];
const [TEAM_A, TEAM_B] = TEAMS as [string, string];
const ends: (() => Promise<unknown>)[] = [];
let database: string;
let withTeam: WithTeam;
let findings: Findings;
/** Each Team's Product, on LangChain 0.0.200, which the snapshot has CVEs for. */
const productOf: Record<string, string> = {};
/** Team A's Open Finding for CVE-2023-36188 under another package of its Product, for Patch's move rule. */
let otherPackage: Finding;

beforeAll(async () => {
  const made = await createMigratedTestDatabase();
  ends.push(made.drop);
  database = made.name;
  await loadTestCveSnapshot(database);
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
    productOf[team] = await seedProduct(withTeam, team, {
      name: "Chatbot",
      dependencies: [
        { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: true },
      ],
    });
  }
  otherPackage = await seedPatchFinding(withTeam, TEAM_A, productOf[TEAM_A]!, {
    cve: "CVE-2023-36188",
    pkg: "pkg:pypi/langchain-community",
  });
}, 60_000);

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

/** Each Team's Finding statuses, sorted: before any run, an accepted Guard Finding each and Team A's seeded one. */
const everyStatus = async () =>
  Promise.all(TEAMS.map(async (team) => (await findings.list(team)).map((f) => f.status).sort()));

const UNTOUCHED = [["accepted", "open"], ["accepted"]];

const patchFindings = async (team: string) =>
  (await findings.list(team)).filter((f) => f.module === "patch");

const cve36188 = (f: Finding) =>
  f.location.kind === "dependency" &&
  f.location.vulnerability === "CVE-2023-36188" &&
  f.location.package === "pkg:pypi/langchain";

const errorLine = (output: string) => logEntries(output).find((e) => e.severity === "ERROR");

describe("the daily Job's process", () => {
  // The admin connection's own role check is checkAdminRole's (daily-expiry.test.ts).
  it("exits 1 before connecting when PGPASSWORD is set but WARDEN_ADMIN_PASSWORD isn't, and changes nothing", async () => {
    const { code, output } = await runJob({ PGPASSWORD: "the-app-password" });

    expect(code, output).toBe(1);
    expect(errorLine(output)?.message).toContain("WARDEN_ADMIN_PASSWORD");
    expect(output).not.toContain("the-app-password");
    expect(await everyStatus()).toEqual(UNTOUCHED);
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
    expect(await everyStatus()).toEqual(UNTOUCHED);
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

  it("reopens the expired acceptance and opens each Product's CVE Findings in each of two Teams, and exits 0", async () => {
    const { code, output } = await runJob();

    expect(code, output).toBe(0);
    for (const team of TEAMS) {
      const guard = (await findings.list(team)).filter((f) => f.module === "guard");
      expect(guard.map((f) => f.status)).toEqual(["open"]);
      const opened = (await patchFindings(team)).filter((f) => f.status === "open");
      expect(opened.length, team).toBeGreaterThan(1);
      expect(opened.filter(cve36188), team).toHaveLength(1);
      for (const f of opened) expect(f.rule_id).toBe(PATCH_RULE);
    }
    expect(logEntries(output).at(-1)).toMatchObject({
      message: "daily expiry done",
      teamsVisited: 2,
      teamsFailed: 0,
      findingsReopened: 2,
      steps: { "patch-refresh": { productsScanned: 2, productsFailed: 0 } },
    });
  }, 60_000);

  it("used Patch's move rule: a CVE now seen under another package of the Product is Fixed with an Unconfirmed fix", async () => {
    const after = await patchFindings(TEAM_A);
    const moved = after.find((f) => f.id === otherPackage.id);
    const opened = after.find((f) => cve36188(f) && f.status === "open");

    expect(moved?.status).toBe("fixed");
    expect(moved?.unconfirmed_fix).toEqual({ candidates: [opened!.id] });
  });

  it("turns Fixed the Findings of the one Team whose stored version passed every fix, and leaves the other's (story 8)", async () => {
    const teamABefore = await findings.list(TEAM_A);
    const historyOf = async (team: string, list: Finding[]) =>
      Promise.all(list.map((f) => findings.history(team, f.id)));
    const teamAHistoryBefore = await historyOf(TEAM_A, teamABefore);
    // Written straight to the table, so no save-time Scan runs: only the Job sees it.
    await withTeam(TEAM_B, (tx) =>
      tx
        .updateTable("product_dependencies")
        .set({ version: "2.0.0" })
        .where("product_id", "=", productOf[TEAM_B]!)
        .execute(),
    );

    const { code, output } = await runJob();

    expect(code, output).toBe(0);
    const teamB = await patchFindings(TEAM_B);
    // Every Finding a fix covers is Fixed. A CVE with no version data "may affect" any version, so it stays Open.
    const fixed = teamB.filter((f) => f.status === "fixed");
    expect(fixed.length).toBeGreaterThan(1);
    expect(fixed.filter(cve36188)).toHaveLength(1);
    for (const f of teamB.filter((f) => f.status !== "fixed")) {
      expect(f.evidence.summary, JSON.stringify(f.location)).toContain("no version data");
    }
    // Team A's Scan saw them again, so only last_seen_scan moved; Team B's Scan changed nothing of Team A's.
    const teamAAfter = await findings.list(TEAM_A);
    const withoutLastSeen = (list: Finding[]) =>
      list.map((f) => ({ ...f, last_seen_scan: "" })).sort((a, b) => a.id.localeCompare(b.id));
    expect(withoutLastSeen(teamAAfter)).toEqual(withoutLastSeen(teamABefore));
    expect(await historyOf(TEAM_A, teamABefore)).toEqual(teamAHistoryBefore);
    expect((await patchFindings(TEAM_A)).filter((f) => f.status === "open").length).toBeGreaterThan(
      1,
    );
    // Each Team's Patch Findings name only its own Product.
    for (const team of TEAMS) {
      const refs = new Set((await patchFindings(team)).map((f) => f.asset.ref));
      expect(refs, team).toEqual(new Set([productOf[team]]));
    }
  }, 60_000);
});
