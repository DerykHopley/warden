// Story 2's start at the API, and story 15 for Scans: a Lead queues a Scan (`POST /api/scans`), which the starter is
// told about with only its id and Team (ADR 0009), and any person in the Team reads it back (`GET /api/scans/:id`).
// Through the real app on the suite's shared database, each case with Teams of its own, a fake scanner and a fake
// starter.
import { randomInt, randomUUID } from "node:crypto";
import { ScanBody, type Asset } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createRepoAssets } from "../src/modules/guard/repo-assets.ts";
import {
  createScans,
  ScanJobStartUnknown,
  type AssetChecks,
  type ScanJobStarter,
  type Scanner,
  type Scanners,
  type Scans,
} from "../src/scans.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { logEntries } from "./server-process.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
});

afterAll(async () => {
  await pool.end();
});

const LEAD = "user_lead";
const MEMBER = "user_member";
const ENV = "guard/agent-can-read-env";
const repo = (n = 1): Asset => ({ kind: "repo", ref: `https://github.com/example/app-${n}` });

/** A scanner for `guard` that names one Rule and sees nothing: the API never runs it. */
const fakeGuard: Scanner = { rules: [ENV], scan: async () => {} };

/** A starter that records each call and starts nothing. */
function fakeStarter() {
  const calls: unknown[] = [];
  const start: ScanJobStarter = async (input) => {
    calls.push(input);
  };
  return { calls, start };
}

/**
 * The app with `scanners` (Guard's fake by default), `startScanJob` and `assetChecks` (none by default), as the
 * start-up file wires them.
 */
function scanApp({
  scanners = { guard: fakeGuard },
  startScanJob,
  scans,
  assetChecks,
}: {
  scanners?: Scanners;
  startScanJob?: ScanJobStarter;
  scans?: Scans;
  assetChecks?: AssetChecks;
} = {}) {
  return testApp({ publicPem, withTeam, scanners, startScanJob, scans, assetChecks });
}

async function newTeam() {
  const team = `org_scans_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);
  return team;
}

type App = ReturnType<typeof scanApp>["app"];

async function call(
  app: App,
  path: string,
  { as, team, body, method = "GET" }: { as: string; team: string; body?: string; method?: string },
) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  // A ScanBody's id or a refusal's error: each case reads the one its status says.
  const answer = (await res.json()) as { id: string; error: string };
  return { status: res.status, headers: res.headers, body: answer };
}

const start = (
  app: App,
  team: string,
  body: unknown = { module: "guard", assets: [repo()] },
  as = LEAD,
) =>
  call(app, "/api/scans", {
    as,
    team,
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const read = (app: App, team: string, id: string, as = MEMBER) =>
  call(app, `/api/scans/${id}`, { as, team });

/** The Team's queued-Scan rows, read as that Team. */
const rows = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("scan_requests").selectAll().orderBy("queued_at").execute());

describe("POST /api/scans: a Lead starts a Scan (story 2)", () => {
  it("answers 202 with the queued Scan, the scanner's Rules and no start or end yet", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });

    const res = await start(app, team);

    expect(res.status).toBe(202);
    const scan = ScanBody.parse(res.body);
    expect(scan).toMatchObject({
      module: "guard",
      state: "queued",
      assets: [repo()],
      rules: [ENV],
      started_at: null,
      ended_at: null,
    });
    expect(await rows(team)).toMatchObject([
      { id: scan.id, state: "queued", requested_by: LEAD, module: "guard" },
    ]);
  });

  it("tells the starter only the Scan's id and the session's Team", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });

    const res = await start(app, team);

    expect(starter.calls).toStrictEqual([{ scanId: res.body.id, team }]);
  });

  it("refuses a Member with 403, writing nothing and starting nothing", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });

    const res = await start(app, team, undefined, MEMBER);

    expect(res.status).toBe(403);
    expect(await rows(team)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });

  it.each([
    ["a body that isn't JSON", "{not json"],
    ["an unknown module", { module: "audit", assets: [repo()] }],
    ["no Assets", { module: "guard", assets: [] }],
    ["101 Assets", { module: "guard", assets: Array.from({ length: 101 }, (_, i) => repo(i)) }],
    ["a repeated Asset", { module: "guard", assets: [repo(1), repo(2), repo(1)] }],
    [
      "an Agent session",
      { module: "guard", assets: [{ kind: "agent_session", ref: "session-1" }] },
    ],
  ])("refuses %s with 400, writing nothing", async (_name, body) => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });

    const res = await start(app, team, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await rows(team)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });

  it("refuses a module with no scanner wired with 400 naming it, writing nothing", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });

    const res = await start(app, team, { module: "patch", assets: [repo()] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/patch/);
    expect(await rows(team)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });

  it("answers 429 with Retry-After for a Team's 11th start in an hour, writing nothing; another Team still starts", async () => {
    const team = await newTeam();
    const other = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });
    for (let i = 0; i < 10; i++) expect((await start(app, team)).status).toBe(202);

    const res = await start(app, team);

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(3500);
    expect(Number(retryAfter)).toBeLessThanOrEqual(3600);
    expect(await rows(team)).toHaveLength(10);
    expect(starter.calls).toHaveLength(10);
    expect((await start(app, other)).status).toBe(202);
  });

  it("counts a failed Scan towards the limit, and waits for the oldest in the hour to age out", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });
    // Ten in the window, the oldest 50 minutes ago and failed; one older than an hour, which doesn't count.
    await withTeam(team, async (tx) => {
      for (let i = 0; i < 11; i++) {
        const minutesAgo = i === 0 ? 61 : i === 1 ? 50 : 1;
        await tx
          .insertInto("scan_requests")
          .values({
            team_id: team,
            id: randomUUID(),
            module: "guard",
            assets: JSON.stringify([repo()]),
            rules: [ENV],
            state: i === 1 ? "failed" : "queued",
            ended_at: i === 1 ? new Date() : null,
            requested_by: LEAD,
            queued_at: new Date(Date.now() - minutesAgo * 60_000),
          })
          .execute();
      }
    });

    const res = await start(app, team);

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(9 * 60);
    expect(retryAfter).toBeLessThanOrEqual(10 * 60);
  });

  it("starts exactly one of eleven sent at once for a Team with 9 in the hour", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = scanApp({ startScanJob: starter.start });
    for (let i = 0; i < 9; i++) expect((await start(app, team)).status).toBe(202);

    const answers = await Promise.all(Array.from({ length: 11 }, () => start(app, team)));

    expect(answers.map((res) => res.status).sort()).toEqual([202, ...Array(10).fill(429)]);
    expect(await rows(team)).toHaveLength(10);
    expect(starter.calls).toHaveLength(10);
  });

  it("marks the Scan failed and answers 502 when the starter throws, logging its id and Team", async () => {
    const team = await newTeam();
    const { app, lines } = scanApp({
      startScanJob: async () => {
        throw new Error("the Admin API said no");
      },
    });

    const res = await start(app, team);

    expect(res).toMatchObject({ status: 502, body: { error: "The Scan couldn't be started" } });
    const [row] = await rows(team);
    expect(row).toMatchObject({ state: "failed" });
    expect(row!.ended_at).toBeInstanceOf(Date);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({ severity: "ERROR", scanId: row!.id, team }),
    );
  });

  it("leaves the Scan queued and answers 202 when the starter can't tell whether the Job started, logging why", async () => {
    const team = await newTeam();
    const { app, lines } = scanApp({
      startScanJob: async () => {
        throw new ScanJobStartUnknown("jobs.run timed out after 10000 ms");
      },
    });

    const res = await start(app, team);

    expect(res.status).toBe(202);
    const scan = ScanBody.parse(res.body);
    expect(scan).toMatchObject({ state: "queued" });
    expect(await rows(team)).toMatchObject([{ id: scan.id, state: "queued", ended_at: null }]);
    expect(logEntries(lines.join(""))).toContainEqual(
      expect.objectContaining({
        severity: "WARNING",
        scanId: scan.id,
        team,
        error: expect.objectContaining({ message: "jobs.run timed out after 10000 ms" }),
      }),
    );
  });

  it("logs the start's error first, then the failed move's own, when the Scan can't be marked failed", async () => {
    const team = await newTeam();
    const real = createScans({ withTeam });
    const { app, lines } = scanApp({
      startScanJob: async () => {
        throw new Error("the Admin API said no");
      },
      scans: {
        ...real,
        move: async () => {
          throw new Error("the connection dropped");
        },
      },
    });

    const res = await start(app, team);

    expect(res).toMatchObject({ status: 502, body: { error: "The Scan couldn't be started" } });
    const [row] = await rows(team);
    expect(row).toMatchObject({ state: "queued" });
    const errors = logEntries(lines.join("")).filter((entry) => entry.severity === "ERROR");
    expect(errors).toEqual([
      expect.objectContaining({
        scanId: row!.id,
        team,
        error: expect.objectContaining({ message: "the Admin API said no" }),
      }),
      expect.objectContaining({
        scanId: row!.id,
        team,
        error: expect.objectContaining({ message: "the connection dropped" }),
      }),
    ]);
  });

  it("answers 503 with no starter wired, writing nothing", async () => {
    const team = await newTeam();
    const { app } = scanApp();

    const res = await start(app, team);

    expect(res).toMatchObject({ status: 503, body: { error: "Scans aren't set up here" } });
    expect(await rows(team)).toEqual([]);
  });
});

describe("POST /api/scans: a Guard Scan names only the Team's Repo Assets (stories 2, 15)", () => {
  /** The app with Guard's check of a start's Assets on the real Repo Assets store, as the start-up file wires it. */
  function checkedApp(startScanJob: ScanJobStarter) {
    const repoAssets = createRepoAssets({ withTeam });
    return { repoAssets, ...scanApp({ startScanJob, assetChecks: { guard: repoAssets.outside } }) };
  }

  /** Links a new installation listing `assets` (repos) to the Team. */
  const linkRepos = (
    repoAssets: ReturnType<typeof createRepoAssets>,
    team: string,
    assets: Asset[],
  ) =>
    repoAssets.link(team, {
      installationId: randomInt(1, 2 ** 47),
      linkedBy: LEAD,
      repos: assets.map((asset, i) => ({ ref: asset.ref, githubId: i + 1 })),
    });

  it("answers 202 and queues the Scan when every Asset is one of the Team's Repo Assets", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app, repoAssets } = checkedApp(starter.start);
    await linkRepos(repoAssets, team, [repo(1), repo(2)]);

    const res = await start(app, team, { module: "guard", assets: [repo(2), repo(1)] });

    expect(res.status).toBe(202);
    expect(await rows(team)).toMatchObject([{ id: res.body.id, state: "queued" }]);
    expect(starter.calls).toStrictEqual([{ scanId: res.body.id, team }]);
  });

  it("refuses a repo another Team holds with 400 naming it, queuing nothing and starting nothing", async () => {
    const team = await newTeam();
    const other = await newTeam();
    const starter = fakeStarter();
    const { app, repoAssets } = checkedApp(starter.start);
    await linkRepos(repoAssets, team, [repo(1)]);
    await linkRepos(repoAssets, other, [repo(7)]);

    const res = await start(app, team, { module: "guard", assets: [repo(1), repo(7), repo(8)] });

    expect(res).toMatchObject({
      status: 400,
      body: { error: `assets[1]: ${repo(7).ref} isn't one of your Team's repos` },
    });
    expect(await rows(team)).toEqual([]);
    expect(await rows(other)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });

  it("refuses a repo no Team holds with 400 naming it, for a Team with no Repo Assets", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app } = checkedApp(starter.start);

    const res = await start(app, team, { module: "guard", assets: [repo(3)] });

    expect(res).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("assets[0]") },
    });
    expect(await rows(team)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });

  it("refuses a product Asset with 400, though a Repo Asset has its ref", async () => {
    const team = await newTeam();
    const starter = fakeStarter();
    const { app, repoAssets } = checkedApp(starter.start);
    await linkRepos(repoAssets, team, [repo(1)]);

    const res = await start(app, team, {
      module: "guard",
      assets: [{ kind: "product", ref: repo(1).ref }],
    });

    expect(res).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("assets[0]") },
    });
    expect(await rows(team)).toEqual([]);
    expect(starter.calls).toEqual([]);
  });
});

describe("GET /api/scans/:id: any person in the Team reads a Scan", () => {
  it("answers a Member the Scan's ScanBody", async () => {
    const team = await newTeam();
    const { app } = scanApp({ startScanJob: fakeStarter().start });
    const started = await start(app, team);

    const res = await read(app, team, started.body.id);

    expect(res.status).toBe(200);
    expect(ScanBody.parse(res.body)).toEqual(started.body);
  });

  it("answers 404 for an id the Team doesn't have", async () => {
    const team = await newTeam();
    const { app } = scanApp();

    expect(await read(app, team, randomUUID())).toMatchObject({
      status: 404,
      body: { error: "No such Scan" },
    });
  });

  it("answers 404 to another Team asking for this Team's Scan (story 15)", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    const { app } = scanApp({ startScanJob: fakeStarter().start });
    const started = await start(app, teamA);

    expect(await read(app, teamB, started.body.id)).toMatchObject({
      status: 404,
      body: { error: "No such Scan" },
    });
  });
});
