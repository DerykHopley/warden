// Story 7's last part: the daily Job reopens every Accepted Finding whose expiry has passed (ADR 0005, ADR 0009).
// `expireAcceptances` per Team, then `runDailyExpiry` over every Team, on the real `withAdmin` (warden_admin, which
// may list Team ids and nothing else) and `withTeam` (warden_app). Each test gets a fresh database of its own, so the
// Teams the Job lists are only the ones it made.
import { fingerprint, type Finding } from "@warden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runDailyExpiry } from "../src/daily-expiry.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createLogger } from "../src/log.ts";
import { createWithAdmin, type WithAdmin } from "../src/with-admin.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createMigratedTestDatabase, poolAs } from "./databases.ts";

const ends: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const end of ends.splice(0).reverse()) await end();
}, 30_000);

/** A fresh migrated database, reached as warden_app (`withTeam`, `findings`) and as warden_admin (`withAdmin`). */
async function freshDatabase() {
  const database = await createMigratedTestDatabase();
  ends.push(database.drop);
  const app = poolAs("warden_app", database.name);
  const admin = poolAs("warden_admin", database.name);
  ends.push(
    () => app.end(),
    () => admin.end(),
  );
  const withTeam = createWithTeam(app);
  const findings = createFindings({ withTeam, moveRules: {} });
  return { withTeam, withAdmin: createWithAdmin(admin), findings };
}

type Db = { withTeam: WithTeam; findings: Findings };

const ENV = "guard/agent-can-read-env";
let made = 0;

/** An Accepted Finding until `until`, at a path of its own. */
function accepted(team: string, until: string): Finding {
  const location = { kind: "file", path: `config/${++made}.json` } as const;
  return {
    id: `f-${made}`,
    team,
    asset: { kind: "repo", ref: "https://github.com/example/app" },
    module: "guard",
    rule_id: ENV,
    fingerprint: fingerprint(ENV, location),
    location,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "accepted",
    unconfirmed_fix: null,
    accepted_reason: "Fixed next sprint",
    accepted_until: until,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
  };
}

/** A Team with an Accepted Finding per `until`, stored straight into `findings`. */
async function newTeam({ withTeam }: Db, team: string, untils: string[]) {
  const all = untils.map((until) => accepted(team, until));
  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    await tx.insertInto("findings").values(all.map(toRow)).execute();
  });
  return all;
}

const statuses = async ({ findings }: Db, team: string) =>
  (await findings.list(team)).map((f) => f.status);

const historyRows = ({ withTeam }: Db, team: string) =>
  withTeam(team, (tx) => tx.selectFrom("finding_history").selectAll().orderBy("id").execute());

const NOW = new Date("2026-12-02T03:00:00Z");
const PAST = "2026-12-01T00:00:00Z";

describe("expireAcceptances", () => {
  it("reopens an Accepted Finding whose until is at or before now, and keeps a later one", async () => {
    const db = await freshDatabase();
    const team = "org_expire";
    const [past, atNow, later] = await newTeam(db, team, [
      PAST,
      NOW.toISOString(),
      "2027-06-01T00:00:00Z",
    ]);

    const reopened = await db.findings.expireAcceptances(team, NOW);

    expect(reopened.sort()).toEqual([past!.id, atNow!.id].sort());
    const after = new Map((await db.findings.list(team)).map((f) => [f.id, f]));
    expect(after.get(past!.id)).toMatchObject({
      status: "open",
      accepted_reason: null,
      accepted_until: null,
    });
    expect(after.get(atNow!.id)).toMatchObject({ status: "open" });
    expect(after.get(later!.id)).toMatchObject({ status: "accepted" });
    expect(await db.findings.history(team, past!.id)).toEqual([
      expect.objectContaining({
        status_before: "accepted",
        status_after: "open",
        cause: { kind: "job", id: "daily-expiry" },
        reason: expect.stringContaining(PAST),
        proposal: null,
      }),
    ]);
    expect(await db.findings.history(team, later!.id)).toEqual([]);
  }, 30_000);

  it("run again with the same now, changes nothing", async () => {
    const db = await freshDatabase();
    await newTeam(db, "org_twice", [PAST]);
    await db.findings.expireAcceptances("org_twice", NOW);
    const before = await historyRows(db, "org_twice");

    expect(await db.findings.expireAcceptances("org_twice", NOW)).toEqual([]);

    expect(await historyRows(db, "org_twice")).toEqual(before);
    expect(before).toHaveLength(1);
  }, 30_000);
});

describe("runDailyExpiry", () => {
  it("over three Teams, one failing: reopens the other two, logs the failure, counts it, and returns 1", async () => {
    const db = await freshDatabase();
    const teams = ["org_run_a", "org_run_b", "org_run_c"];
    for (const team of teams) await newTeam(db, team, [PAST]);
    const failing = "org_run_b";
    const lines: string[] = [];
    const wrapped: Findings = {
      ...db.findings,
      expireAcceptances: (team, now) =>
        team === failing
          ? Promise.reject(new Error("the Team's lock timed out"))
          : db.findings.expireAcceptances(team, now),
    };

    const code = await runDailyExpiry({
      withAdmin: db.withAdmin,
      findings: wrapped,
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(1);
    expect(await statuses(db, "org_run_a")).toEqual(["open"]);
    expect(await statuses(db, "org_run_b")).toEqual(["accepted"]);
    expect(await statuses(db, "org_run_c")).toEqual(["open"]);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        team: failing,
        error: expect.objectContaining({ message: "the Team's lock timed out" }),
      }),
    );
    expect(logged.at(-1)).toMatchObject({ teamsVisited: 3, teamsFailed: 1, findingsReopened: 2 });
  }, 30_000);

  it("with none failing, reopens each Team's and returns 0", async () => {
    const db = await freshDatabase();
    for (const team of ["org_ok_a", "org_ok_b"]) await newTeam(db, team, [PAST]);
    const lines: string[] = [];

    const code = await runDailyExpiry({
      ...db,
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      teamsVisited: 2,
      teamsFailed: 0,
      findingsReopened: 2,
    });
  }, 30_000);

  it("returns 1, logging the error, when the Team list can't be read", async () => {
    const lines: string[] = [];
    const broken: WithAdmin = () => Promise.reject(new Error("permission denied for table teams"));
    const untouched = { expireAcceptances: () => Promise.reject(new Error("never called")) };

    const code = await runDailyExpiry({
      withAdmin: broken,
      findings: untouched as unknown as Findings,
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("permission denied for table teams");
    expect(lines.join("\n")).not.toContain("never called");
  });
});
