// Story 2's run (ADR 0009): the Scan Job reads its queued Scan by id and Team, runs the module's scanner through
// `findings.scan`, and moves the Scan's state. On the real `withTeam` (warden_app) over the suite's shared database,
// each case with Teams of its own, and fake scanners.
import { randomUUID } from "node:crypto";
import { ScanBody, type Asset, type Observation } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { runScanJob } from "../src/scan-job.ts";
import { createScans, type Scanner, type Scans } from "../src/scans.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";
import { logEntries } from "./server-process.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let scans: Scans;
let findings: Findings;
let key: CryptoKey;
let publicPem: string;

beforeAll(async () => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  scans = createScans({ withTeam });
  findings = createFindings({ withTeam, moveRules: { guard: guardMoveRule } });
  ({ privateKey: key, publicPem } = await testKey());
});

afterAll(async () => {
  await pool.end();
});

const LEAD = "user_lead";
const ENV = "guard/agent-can-read-env";
const app: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const problem: Observation = {
  asset: app,
  rule_id: ENV,
  location: { kind: "file", path: ".claude/settings.json", line: 3 },
  severity: "high",
  title: "The agent can read .env files",
  evidence: { summary: "permissions.allow lets the agent read .env" },
};

/** A Guard scanner that sees `seen` and counts its runs. */
function fakeScanner(seen: Observation[] = [problem]) {
  const runs: { team: string; assets: Asset[]; rules: string[] }[] = [];
  const scanner: Scanner = {
    rules: [ENV],
    async scan(target, recorder) {
      runs.push(target);
      for (const observation of seen) recorder.saw(observation);
    },
  };
  return { runs, scanner };
}

const throwingScanner: Scanner = {
  rules: [ENV],
  scan: async () => {
    throw new Error("the repo couldn't be cloned");
  },
};

async function newTeam() {
  const team = `org_scanjob_${randomUUID()}`;
  await seedTeam(withTeam, team, [[LEAD, "lead"]]);
  return team;
}

/** A Guard Scan of `app` queued for `team`, as `POST /api/scans` queues it. */
async function queued(team: string): Promise<ScanBody> {
  const outcome = await scans.queue(team, {
    module: "guard",
    assets: [app],
    rules: [ENV],
    requestedBy: LEAD,
  });
  if (outcome.kind !== "queued") throw new Error("the test's Scan was rate limited");
  return outcome.scan;
}

type Move = () => Promise<ScanBody | undefined>;

/** The real Scans, except that a move to `state` runs `instead`, which may make the real move or throw without it. */
function scansWhere(
  state: Parameters<Scans["move"]>[2],
  instead: (move: Move) => ReturnType<Move>,
) {
  return {
    ...scans,
    move: (team, id, to) =>
      to === state ? instead(() => scans.move(team, id, to)) : scans.move(team, id, to),
  } satisfies Scans;
}

const dropped = async (): ReturnType<Move> => {
  throw new Error("the connection dropped");
};

/** Puts the Scan's row back to running, as a Job killed after reconcile but before `done` leaves it. */
async function setBackToRunning(team: string, id: string) {
  await withTeam(team, (tx) =>
    tx
      .updateTable("scan_requests")
      .set({ state: "running", ended_at: null })
      .where("id", "=", id)
      .execute(),
  );
}

function job(
  team: string,
  scanId: string,
  scanner: Scanner | undefined,
  { through = scans }: { through?: Scans } = {},
) {
  const lines: string[] = [];
  const run = runScanJob({
    scanId,
    team,
    scans: through,
    findings,
    scanners: scanner ? { guard: scanner } : {},
    logger: createLogger((line) => lines.push(line)),
  });
  return { run, lines };
}

describe("runScanJob", () => {
  it("runs the scanner, opens the Finding it saw and leaves the Scan done, as GET reads it (story 2)", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const { runs, scanner } = fakeScanner();

    expect(await job(team, scan.id, scanner).run).toBe(0);

    expect(runs).toEqual([{ team, assets: [app], rules: [ENV] }]);
    const [finding, ...others] = await findings.list(team);
    expect(others).toEqual([]);
    expect(finding).toMatchObject({ rule_id: ENV, status: "open", first_seen_scan: scan.id });
    const applied = await withTeam(team, (tx) =>
      tx.selectFrom("scans").select(["id", "module", "kind"]).execute(),
    );
    expect(applied).toEqual([{ id: scan.id, module: "guard", kind: "scan" }]);
    const after = await scans.get(team, scan.id);
    expect(after).toMatchObject({ state: "done" });
    expect(after!.started_at).toEqual(expect.any(String));
    expect(after!.ended_at).toEqual(expect.any(String));

    const { app: api } = testApp({ publicPem, withTeam });
    const token = await sessionToken(key, LEAD, 60, activeOrganization(team));
    const res = await api.request(`/api/scans/${scan.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(ScanBody.parse(await res.json())).toMatchObject({ id: scan.id, state: "done" });
  });

  it("marks the Scan failed and opens nothing when the scanner throws", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const { run, lines } = job(team, scan.id, throwingScanner);

    expect(await run).toBe(1);

    expect(await scans.get(team, scan.id)).toMatchObject({ state: "failed" });
    expect(await findings.list(team)).toEqual([]);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({ severity: "ERROR", scanId: scan.id, team }),
    );
  });

  it("changes nothing when run again after the row is set back to running (a retried execution)", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    expect(await job(team, scan.id, fakeScanner().scanner).run).toBe(0);
    const first = await findings.list(team);
    await setBackToRunning(team, scan.id);

    expect(await job(team, scan.id, fakeScanner().scanner).run).toBe(0);

    expect(await findings.list(team)).toEqual(first);
    expect(first).toHaveLength(1);
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "done" });
  });

  it("leaves the Scan running for a retry, not failed, when the move to done fails after reconcile", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const through = scansWhere("done", dropped);
    const { run, lines } = job(team, scan.id, fakeScanner().scanner, { through });

    expect(await run).toBe(1);

    expect(await findings.list(team)).toHaveLength(1);
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "running" });
    const errors = logEntries(lines.join("")).filter((entry) => entry.severity === "ERROR");
    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("reconciled"),
        scanId: scan.id,
        error: expect.objectContaining({ message: "the connection dropped" }),
      }),
    ]);
    expect(errors[0]!.message).not.toContain("nothing was reconciled");

    expect(await job(team, scan.id, fakeScanner().scanner).run).toBe(0);
    expect(await findings.list(team)).toHaveLength(1);
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "done" });
  });

  it("runs a failed Scan again", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    expect(await job(team, scan.id, throwingScanner).run).toBe(1);

    expect(await job(team, scan.id, fakeScanner().scanner).run).toBe(0);

    expect(await findings.list(team)).toHaveLength(1);
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "done" });
  });

  it("starts a failed Scan's rerun afresh, so a Scan run in between doesn't supersede what it sees", async () => {
    const team = await newTeam();
    const failed = await queued(team);
    expect(await job(team, failed.id, throwingScanner).run).toBe(1);
    const between = await queued(team);
    expect(await job(team, between.id, fakeScanner([]).scanner).run).toBe(0);

    expect(await job(team, failed.id, fakeScanner().scanner).run).toBe(0);

    expect(await findings.list(team)).toEqual([
      expect.objectContaining({ rule_id: ENV, status: "open", first_seen_scan: failed.id }),
    ]);
    const [rerun, other] = [await scans.get(team, failed.id), await scans.get(team, between.id)];
    expect(Date.parse(rerun!.started_at!)).toBeGreaterThan(Date.parse(other!.started_at!));
  });

  it("logs the scanner's error even when the move to failed fails too", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const through = scansWhere("failed", dropped);
    const { run, lines } = job(team, scan.id, throwingScanner, { through });

    expect(await run).toBe(1);

    expect(logEntries(lines.join(""))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "ERROR",
          scanId: scan.id,
          error: expect.objectContaining({ message: "the repo couldn't be cloned" }),
        }),
        expect.objectContaining({
          severity: "ERROR",
          scanId: scan.id,
          error: expect.objectContaining({ message: "the connection dropped" }),
        }),
      ]),
    );
  });

  it("ends the Scan failed when it has no start after moving to running", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const through = scansWhere("running", async (move) => {
      const moved = await move();
      return moved && { ...moved, started_at: null };
    });
    const counting = fakeScanner();

    expect(await job(team, scan.id, counting.scanner, { through }).run).toBe(1);

    expect(counting.runs).toEqual([]);
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "failed" });
  });

  it("returns 0 for a Scan already done, without running the scanner", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    await job(team, scan.id, fakeScanner().scanner).run;
    const before = await scans.get(team, scan.id);
    const counting = fakeScanner();

    expect(await job(team, scan.id, counting.scanner).run).toBe(0);

    expect(counting.runs).toEqual([]);
    expect(await scans.get(team, scan.id)).toEqual(before);
  });

  it("returns 1 and changes nothing for another Team's Scan id", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    const scan = await queued(teamA);
    const counting = fakeScanner();
    const { run, lines } = job(teamB, scan.id, counting.scanner);

    expect(await run).toBe(1);

    expect(counting.runs).toEqual([]);
    expect(await scans.get(teamA, scan.id)).toEqual(scan);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({ severity: "ERROR", scanId: scan.id, team: teamB }),
    );
  });

  it("returns 0 and leaves the Scan done when another attempt finished it after this one read it", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    await job(team, scan.id, fakeScanner().scanner).run;
    const done = await scans.get(team, scan.id);
    // This attempt read the row while it was still queued.
    const through = { ...scans, get: async () => ({ ...done!, state: "queued" as const }) };
    const counting = fakeScanner();

    expect(await job(team, scan.id, counting.scanner, { through }).run).toBe(0);

    expect(counting.runs).toEqual([]);
    expect(await scans.get(team, scan.id)).toEqual(done);
  });

  it("returns 1 and changes nothing when the Scan's module has no scanner", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    const { run, lines } = job(team, scan.id, undefined);

    expect(await run).toBe(1);

    expect(await scans.get(team, scan.id)).toEqual(scan);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({ severity: "ERROR", scanId: scan.id, module: "guard" }),
    );
  });
});

describe("Scans.move", () => {
  it("never moves a Scan out of done: a late attempt answers undefined and changes nothing", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    await job(team, scan.id, fakeScanner().scanner).run;
    const done = await scans.get(team, scan.id);

    expect(await scans.move(team, scan.id, "failed")).toBeUndefined();
    expect(await scans.move(team, scan.id, "running")).toBeUndefined();

    expect(await scans.get(team, scan.id)).toEqual(done);
  });
});
