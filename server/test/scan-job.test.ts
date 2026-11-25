// Story 2's run (ADR 0009): the Scan Job reads its queued Scan by id and Team, runs the module's scanner through
// `findings.scan`, and moves the Scan's state. On the real `withTeam` (warden_app) over the suite's shared database,
// each case with Teams of its own, and fake scanners.
import { randomUUID } from "node:crypto";
import { ScanBody, type Asset, type Observation } from "@warden/contracts";
import type { CryptoKey } from "jose";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger, type Logger } from "../src/log.ts";
import type { GitHubRepo } from "../src/modules/guard/github.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import type { RepoFile, RepoReader } from "../src/modules/guard/repo-reader.ts";
import { runScanJob } from "../src/scan-job.ts";
import {
  createScans,
  QUEUED_SCAN_LIMIT_MINUTES,
  type Scanner,
  type Scanners,
  type Scans,
} from "../src/scans.ts";
import { scanners } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { AWS_KEY } from "./secret-fixtures.ts";
import {
  activeOrganization,
  linkRepos,
  minutesAgo,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";
import { logEntries } from "./server-process.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let scans: Scans;
let findings: Findings;
let repoAssets: RepoAssets;
let key: CryptoKey;
let publicPem: string;

beforeAll(async () => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  scans = createScans({ withTeam });
  findings = createFindings({ withTeam, moveRules: { guard: guardMoveRule } });
  repoAssets = createRepoAssets({ withTeam });
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

/**
 * Runs the Job with `scanner` as Guard's, or with the scanners `scanners` builds over the Job's logger, so the
 * scanners' log lines land in `lines` too.
 */
function job(
  team: string,
  scanId: string,
  scanner: Scanner | undefined,
  {
    through = scans,
    scanners: build,
  }: { through?: Scans; scanners?: (logger: Logger) => Scanners } = {},
) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const run = runScanJob({
    scanId,
    team,
    scans: through,
    findings,
    scanners: build ? build(logger) : scanner ? { guard: scanner } : {},
    logger,
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

  it("still runs a Scan the time limit ended, when its Job starts late", async () => {
    const team = await newTeam();
    const scan = await queued(team);
    // Its Job never started in time: set its queueing back past the limit (the schema keeps `queued_at` unwritable),
    // and read it, which ends it.
    const late = minutesAgo(QUEUED_SCAN_LIMIT_MINUTES + 5);
    await withTeam(team, (tx) =>
      sql`update scan_requests set queued_at = ${late} where id = ${scan.id}`.execute(tx),
    );
    expect(await scans.get(team, scan.id)).toMatchObject({ state: "failed" });

    expect(await job(team, scan.id, fakeScanner().scanner).run).toBe(0);

    const after = await scans.get(team, scan.id);
    expect(after).toMatchObject({ state: "done" });
    expect(after!.started_at).toEqual(expect.any(String));
    expect(await findings.list(team)).toEqual([
      expect.objectContaining({ rule_id: ENV, status: "open", first_seen_scan: scan.id }),
    ]);
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

describe("runScanJob with Guard's scanner (stories 3, 15)", () => {
  const repoA: Asset = { kind: "repo", ref: "https://github.com/example/repo-a" };
  const repoB: Asset = { kind: "repo", ref: "https://github.com/example/repo-b" };
  const withSecret: RepoFile[] = [{ path: "src/config.ts", text: `const key = "${AWS_KEY}";` }];
  const clean: RepoFile[] = [{ path: "src/config.ts", text: "const key = process.env.KEY;" }];

  /** A RepoReader that gives each ref's files and records each call; a ref it has no files for can't be read. */
  function fakeReader(files: Record<string, RepoFile[]>) {
    const calls: { installationId: number; repo: GitHubRepo }[] = [];
    const reader: RepoReader = {
      async *readRepo(installationId, repo) {
        calls.push({ installationId, repo });
        const given = files[repo.ref];
        if (given === undefined) throw new Error(`the reader can't read ${repo.ref}`);
        yield* given;
      },
    };
    return { calls, reader };
  }

  /** A Guard Scan of `assets` queued for `team`, with the Rules Guard's scanner names. */
  async function queuedGuard(team: string, assets: Asset[]) {
    const { guard } = scanners({ withTeam, logger: createLogger(() => {}) });
    const outcome = await scans.queue(team, {
      module: "guard",
      assets,
      rules: [...guard!.rules],
      requestedBy: LEAD,
    });
    if (outcome.kind !== "queued") throw new Error("the test's Scan was rate limited");
    return outcome.scan;
  }

  /** The Job's options for Guard's scanner as the wiring builds it, given `reader` (none: as the Job is wired today). */
  const wired = (reader?: RepoReader) => ({
    scanners: (logger: Logger) => scanners({ withTeam, reader, logger }),
  });

  const statuses = async (team: string) =>
    Object.fromEntries(
      (await findings.list(team)).map((finding) => [finding.asset.ref, finding.status]),
    );

  it("fails a Guard Scan with no reader, logging that GitHub isn't set up for the Scan Job", async () => {
    const team = await newTeam();
    await linkRepos(repoAssets, team, [repoA.ref], LEAD);
    const scan = await queuedGuard(team, [repoA]);
    const { run, lines } = job(team, scan.id, undefined, wired());

    expect(await run).toBe(1);

    expect(await scans.get(team, scan.id)).toMatchObject({ state: "failed" });
    expect(await findings.list(team)).toEqual([]);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        scanId: scan.id,
        error: expect.objectContaining({ message: "GitHub isn't set up for the Scan Job" }),
      }),
    );
  });

  it("reads only the repos the Team still holds: a repo a relink dropped keeps its Open Finding (story 15)", async () => {
    const team = await newTeam();
    const installationId = await linkRepos(repoAssets, team, [repoA.ref, repoB.ref], LEAD);
    const first = await queuedGuard(team, [repoA, repoB]);
    const before = fakeReader({ [repoA.ref]: withSecret, [repoB.ref]: withSecret });
    expect(await job(team, first.id, undefined, wired(before.reader)).run).toBe(0);
    expect(await statuses(team)).toEqual({ [repoA.ref]: "open", [repoB.ref]: "open" });

    const second = await queuedGuard(team, [repoA, repoB]);
    // An Admin relinks the installation without repo B before the Job runs.
    await repoAssets.link(team, {
      installationId,
      linkedBy: LEAD,
      repos: [{ ref: repoA.ref, githubId: 1 }],
    });
    const after = fakeReader({ [repoA.ref]: clean, [repoB.ref]: clean });
    const { run, lines } = job(team, second.id, undefined, wired(after.reader));

    expect(await run).toBe(0);

    expect(after.calls).toEqual([{ installationId, repo: { ref: repoA.ref, githubId: 1 } }]);
    expect(await statuses(team)).toEqual({ [repoA.ref]: "fixed", [repoB.ref]: "open" });
    const covered = await withTeam(team, (tx) =>
      tx
        .selectFrom("scan_coverage")
        .select("asset_ref")
        .distinct()
        .where("scan_id", "=", second.id)
        .execute(),
    );
    expect(covered).toEqual([{ asset_ref: repoA.ref }]);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({ message: "scan job done", scanId: second.id, dropped: 1 }),
    );
  });

  it("reads nothing and fails a Scan in Team B naming Team A's repo; Team A's Findings are unchanged (story 15)", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    await linkRepos(repoAssets, teamA, [repoA.ref], LEAD);
    const scanA = await queuedGuard(teamA, [repoA]);
    expect(
      await job(teamA, scanA.id, undefined, wired(fakeReader({ [repoA.ref]: withSecret }).reader))
        .run,
    ).toBe(0);
    const teamAFindings = await findings.list(teamA);
    expect(teamAFindings).toHaveLength(1);
    // Past the route's check: the row is queued straight through the store.
    const scanB = await queuedGuard(teamB, [repoA]);
    const reader = fakeReader({ [repoA.ref]: clean });
    const { run, lines } = job(teamB, scanB.id, undefined, wired(reader.reader));

    expect(await run).toBe(1);

    expect(reader.calls).toEqual([]);
    expect(await scans.get(teamB, scanB.id)).toMatchObject({ state: "failed" });
    expect(await findings.list(teamB)).toEqual([]);
    expect(await findings.list(teamA)).toEqual(teamAFindings);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        scanId: scanB.id,
        error: expect.objectContaining({ message: expect.stringContaining("1 dropped") }),
      }),
    );
  });

  it("skips a file whose path a Finding can't hold, and counts it in the repo's log line without the path (story 3)", async () => {
    const team = await newTeam();
    await linkRepos(repoAssets, team, [repoA.ref], LEAD);
    const scan = await queuedGuard(team, [repoA]);
    // Over 1024 characters, a `\`, and a drive letter: each refused as a Location's path.
    const refused = [`${"deep/".repeat(205)}config.ts`, "src\\config.ts", "C:/config.ts"];
    const reader = fakeReader({
      [repoA.ref]: [
        ...refused.map((path) => ({ path, text: `const key = "${AWS_KEY}";` })),
        ...withSecret,
      ],
    });
    const { run, lines } = job(team, scan.id, undefined, wired(reader.reader));

    expect(await run).toBe(0);

    expect((await findings.list(team)).map((finding) => finding.location)).toEqual([
      { kind: "file", path: "src/config.ts", line: 1 },
    ]);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({
        message: "guard scan: repo read",
        files: 4,
        skipped: 3,
        observations: 1,
      }),
    );
    expect(lines.join("")).not.toContain("config.ts");
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
