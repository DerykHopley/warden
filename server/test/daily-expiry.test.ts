// Story 7's last part: the daily Job reopens every Accepted Finding whose expiry has passed (ADR 0005, ADR 0009).
// `expireAcceptances` per Team, then `runDailyExpiry` over every Team, on the real `withAdmin` (warden_admin, which
// may list Team ids and nothing else) and `withTeam` (warden_app). Each test gets a fresh database of its own, so the
// Teams the Job lists are only the ones it made.
import { fingerprint, type Finding } from "@warden/contracts";
import { afterEach, describe, expect, inject, it } from "vitest";
import { checkAdminRole, runDailyExpiry, type DailyStep } from "../src/daily-expiry.ts";
import { createPool, DATABASE_ROLE_NAMES } from "../src/database.ts";
import { applyExpiry } from "../src/findings/expiry.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createLogger } from "../src/log.ts";
import { createWithAdmin, type WithAdmin } from "../src/with-admin.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createMigratedTestDatabase, poolAs, testName } from "./databases.ts";
import { patchRefresh, seedPatchFinding, seedProduct } from "./helpers.ts";

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
  return { app, withTeam, withAdmin: createWithAdmin(admin), findings };
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

// The dashboard sends a picked "Reopens on" day as its start in the person's time zone (#88). The Job runs at 04:00
// UTC, which falls on the picked day in every zone from UTC-12 to UTC+14 once that day has started: that run reopens
// it, and the one before, still on the day before there, does not.
describe("applyExpiry on a Reopens on day sent as its start", () => {
  it.each([
    // zone, the picked day's start as the dashboard sends it, the 04:00 UTC run on the day before there, on the day
    ["UTC-10", "2027-01-15T00:00:00.000-10:00", "2027-01-15T04:00:00Z", "2027-01-16T04:00:00Z"],
    ["UTC", "2027-01-15T00:00:00.000+00:00", "2027-01-14T04:00:00Z", "2027-01-15T04:00:00Z"],
    ["UTC+14", "2027-01-15T00:00:00.000+14:00", "2027-01-14T04:00:00Z", "2027-01-15T04:00:00Z"],
  ])(
    "in %s, the run on the day before keeps it Accepted, and the run on the picked day reopens it",
    async (zone, until, dayBefore, onTheDay) => {
      const db = await freshDatabase();
      const team = `org_reopens_${zone.replace(/\W/g, "_").toLowerCase()}`;
      const [picked] = await newTeam(db, team, [until]);
      const run = (now: string) => db.withTeam(team, (tx) => applyExpiry(tx, team, new Date(now)));

      expect(await run(dayBefore)).toEqual([]);
      expect(await statuses(db, team)).toEqual(["accepted"]);

      expect(await run(onTheDay)).toEqual([picked!.id]);
      expect(await statuses(db, team)).toEqual(["open"]);
    },
    30_000,
  );
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

  it("gives up on a Team stuck behind its lock, logs it as failed, and goes on to the next", async () => {
    const db = await freshDatabase();
    for (const team of ["org_stuck_a", "org_stuck_b", "org_stuck_c"])
      await newTeam(db, team, [PAST]);
    // Another transaction holds org_stuck_b's Findings lock (the one reconcile and decisions take) throughout.
    const holder = await db.app.connect();
    const lines: string[] = [];
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        "org_stuck_b",
      ]);

      const code = await runDailyExpiry({
        withAdmin: db.withAdmin,
        // The Job's own limits are 30 s and 60 s; the test's are short.
        findings: {
          expireAcceptances: (team, now) =>
            db.findings.expireAcceptances(team, now, { lockTimeoutMs: 200 }),
        },
        logger: createLogger((line) => lines.push(line)),
        now: NOW,
      });

      expect(code).toBe(1);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await statuses(db, "org_stuck_a")).toEqual(["open"]);
    expect(await statuses(db, "org_stuck_b")).toEqual(["accepted"]);
    expect(await statuses(db, "org_stuck_c")).toEqual(["open"]);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        team: "org_stuck_b",
        error: expect.objectContaining({ code: "55P03" }),
      }),
    );
    expect(logged.at(-1)).toMatchObject({ teamsVisited: 3, teamsFailed: 1, findingsReopened: 2 });
  }, 30_000);

  it("on a database with no Team, warns naming the likely cause, and returns 0", async () => {
    const db = await freshDatabase();
    const lines: string[] = [];

    const code = await runDailyExpiry({
      ...db,
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(0);
    const warning = lines.map((line) => JSON.parse(line)).find((e) => e.severity === "WARNING");
    expect(warning?.message).toContain("teams_admin_lists_ids");
  }, 30_000);

  it("returns 1, logging the error, when the Team list can't be read", async () => {
    const lines: string[] = [];
    const broken: WithAdmin = () => Promise.reject(new Error("permission denied for table teams"));
    const untouched = { expireAcceptances: () => Promise.reject(new Error("never called")) };

    const code = await runDailyExpiry({
      withAdmin: broken,
      findings: untouched,
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("permission denied for table teams");
    expect(lines.join("\n")).not.toContain("never called");
  });
});

describe("runDailyExpiry's per-Team steps", () => {
  /** A step that records each Team it runs for, throws for `throwsFor`, and reports `failsFor` as failed. */
  function fakeStep(name: string, { throwsFor = "", failsFor = "" } = {}) {
    const ran: string[] = [];
    const step: DailyStep = {
      name,
      run: async (team) => {
        ran.push(team);
        if (team === throwsFor) throw new Error(`${name} broke for ${team}`);
        return { failed: team === failsFor, counts: { things: 1 } };
      },
    };
    return { step, ran };
  }

  it("a step throwing for one Team is logged with the Team and the step's name; the rest still run, and it returns 1", async () => {
    const db = await freshDatabase();
    const teams = ["org_step_a", "org_step_b", "org_step_c"];
    for (const team of teams) await newTeam(db, team, [PAST]);
    const first = fakeStep("first", { throwsFor: "org_step_a" });
    const second = fakeStep("second");
    const lines: string[] = [];

    const code = await runDailyExpiry({
      ...db,
      steps: [first.step, second.step],
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(1);
    expect(first.ran).toEqual(teams);
    expect(second.ran).toEqual(teams);
    for (const team of teams) expect(await statuses(db, team)).toEqual(["open"]);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.filter((e) => e.severity === "ERROR")).toEqual([
      expect.objectContaining({
        team: "org_step_a",
        step: "first",
        error: expect.objectContaining({ message: "first broke for org_step_a" }),
      }),
    ]);
    expect(logged.at(-1)).toMatchObject({
      message: "daily expiry done",
      teamsVisited: 3,
      teamsFailed: 1,
      findingsReopened: 3,
    });
    // The Team the first step threw for counts under that step, so its counts don't read as clean.
    expect(logged.at(-1).steps).toEqual({
      first: { things: 2, teamsFailed: 1 },
      second: { things: 3, teamsFailed: 0 },
    });
  }, 30_000);

  it("a step reporting a Team as failed counts the Team failed, logged with the step's name, and returns 1", async () => {
    const db = await freshDatabase();
    for (const team of ["org_report_a", "org_report_b"]) await newTeam(db, team, [PAST]);
    const reporting = fakeStep("reporting", { failsFor: "org_report_b" });
    const lines: string[] = [];

    const code = await runDailyExpiry({
      ...db,
      steps: [reporting.step],
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(1);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.filter((e) => e.severity === "ERROR")).toEqual([
      expect.objectContaining({ team: "org_report_b", step: "reporting" }),
    ]);
    expect(logged.at(-1)).toMatchObject({ teamsFailed: 1 });
    expect(logged.at(-1).steps).toEqual({ reporting: { things: 2, teamsFailed: 1 } });
  }, 30_000);

  it("with the expiry and every step passing for every Team, returns 0", async () => {
    const db = await freshDatabase();
    for (const team of ["org_pass_a", "org_pass_b"]) await newTeam(db, team, [PAST]);
    const one = fakeStep("one");
    const two = fakeStep("two");
    const lines: string[] = [];

    const code = await runDailyExpiry({
      ...db,
      steps: [one.step, two.step],
      logger: createLogger((line) => lines.push(line)),
      now: NOW,
    });

    expect(code).toBe(0);
    expect(lines.map((line) => JSON.parse(line).severity)).not.toContain("ERROR");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      teamsFailed: 0,
      steps: { one: { things: 2 }, two: { things: 2 } },
    });
  }, 30_000);

  // Bug slice 6: on a database where load-cves hasn't run, Patch's step must change no Finding.
  it("with the CVE snapshot not loaded, Patch's step changes no Patch Finding and logs why, the expiry still runs, and it returns 1", async () => {
    const db = await freshDatabase();
    const team = "org_no_snapshot";
    await newTeam(db, team, [PAST]);
    const productId = await seedProduct(db.withTeam, team, { name: "Chatbot" });
    const patch = await seedPatchFinding(db.withTeam, team, productId, { cve: "CVE-2023-36188" });
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    const code = await runDailyExpiry({
      ...db,
      steps: [patchRefresh(db.withTeam, logger)],
      logger,
      now: NOW,
    });

    expect(code).toBe(1);
    const after = await db.findings.list(team);
    expect(after.find((f) => f.id === patch.id)).toEqual(patch);
    expect(after.filter((f) => f.module === "guard").map((f) => f.status)).toEqual(["open"]);
    const errors = lines.map((line) => JSON.parse(line)).filter((e) => e.severity === "ERROR");
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain("cve_snapshot");
    expect(JSON.stringify(errors)).toContain("load-cves");
  }, 30_000);
});

// The Job's check on its admin connection, before it lists anything: on the suite's shared database.
describe("checkAdminRole", () => {
  const database = inject("testDatabase");
  const silent = createLogger(() => {});

  async function checkAs(role: string, names: { admin: string } = DATABASE_ROLE_NAMES) {
    const pool = createPool(silent, { user: role, database, max: 1 });
    try {
      return await checkAdminRole(pool, names);
    } finally {
      await pool.end();
    }
  }

  it("passes warden_admin", async () => {
    await expect(checkAs("warden_admin")).resolves.toBeUndefined();
  });

  it("refuses a connection as warden_app, naming it", async () => {
    await expect(checkAs("warden_app")).rejects.toThrow(
      "the admin connection is warden_app, not warden_admin",
    );
  });

  it("refuses the admin role when it has BYPASSRLS", async () => {
    // A test-named admin role, as roles belong to the whole Postgres server.
    const superuser = createPool(silent, { database, max: 1 });
    const admin = `${testName()}_admin`;
    try {
      await superuser.query(`create role ${admin} login bypassrls`);
      await superuser.query(`grant connect on database ${database} to ${admin}`);

      await expect(checkAs(admin, { ...DATABASE_ROLE_NAMES, admin })).rejects.toThrow(
        `${admin} has BYPASSRLS`,
      );
    } finally {
      await superuser.query(`revoke connect on database ${database} from ${admin}`);
      await superuser.query(`drop role if exists ${admin}`);
      await superuser.end();
    }
  });
});
