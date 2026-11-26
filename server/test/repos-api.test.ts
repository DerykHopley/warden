// Story 1's list at the API, and story 15 for it: any person in a Team reads its Repo Assets (`GET /api/repos`), and
// another Team never sees them. Story 2's view of them: each with its last Guard Scan. Through the real app with
// Guard's routes, on the suite's shared database, each case with Teams and installation ids of its own.
import { ReposBody, ScanBody, type Asset } from "@warden/contracts";
import type { CryptoKey } from "jose";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
import { createScans, QUEUED_SCAN_LIMIT_MINUTES, type Scans } from "../src/scans.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  linkRepos,
  newTeam,
  repoRef,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let repoAssets: RepoAssets;
let scans: Scans;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  repoAssets = createRepoAssets({ withTeam });
  scans = createScans({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

const MEMBER = "user_member";

const teamWithMember = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ]);

/** `GET /api/repos` as `as`, through Guard's routes as the start-up file wires them, or without `scans`. */
async function readRepos(team: string, { as = MEMBER, withScans = true } = {}) {
  const routes = guardRoutes(withScans ? { repoAssets, scans } : { repoAssets });
  const { app } = testApp({ publicPem, withTeam, moduleRoutes: [routes] });
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request("/api/repos", { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
}

const repo = (name: string): Asset => ({ kind: "repo", ref: repoRef(name) });

/** Queues a Guard Scan of `names` for the Team, as a Lead's start does, and answers it. */
async function queueGuardScan(team: string, names: string[]) {
  const outcome = await scans.queue(team, {
    module: "guard",
    assets: names.map(repo),
    rules: ["guard/secret-in-repo"],
    requestedBy: ADMIN,
  });
  if (outcome.kind !== "queued") throw new Error("the test's Scan was rate limited");
  return outcome.scan;
}

describe("GET /api/repos: any person in the Team reads its Repo Assets (story 1)", () => {
  it("answers a Member 200 with the Team's Repo Assets, by ref, as ReposBody", async () => {
    const team = await teamWithMember();
    const installationId = await linkRepos(repoAssets, team, [repoRef("web"), repoRef("api")]);

    const res = await readRepos(team);

    expect(res.status).toBe(200);
    expect(ReposBody.parse(res.body)).toEqual({
      repos: [
        {
          asset: { kind: "repo", ref: repoRef("api") },
          installation_id: installationId,
          listed_at: expect.any(String),
          last_scan: null,
        },
        {
          asset: { kind: "repo", ref: repoRef("web") },
          installation_id: installationId,
          listed_at: expect.any(String),
          last_scan: null,
        },
      ],
    });
  });

  it("answers { repos: [] } for a Team with none", async () => {
    const res = await readRepos(await teamWithMember());

    expect(res).toEqual({ status: 200, body: { repos: [] } });
  });

  it("never lists Team A's Repo Assets to Team B (story 15)", async () => {
    const teamA = await teamWithMember();
    const teamB = await teamWithMember();
    await linkRepos(repoAssets, teamA, [repoRef("a-only")]);
    const installationB = await linkRepos(repoAssets, teamB, [repoRef("b-only")]);

    const res = await readRepos(teamB);

    expect(ReposBody.parse(res.body).repos).toEqual([
      {
        asset: { kind: "repo", ref: repoRef("b-only") },
        installation_id: installationB,
        listed_at: expect.any(String),
        last_scan: null,
      },
    ]);
  });
});

describe("GET /api/repos: each repo's last Scan (story 2)", () => {
  const lastScans = (body: unknown) =>
    ReposBody.parse(body).repos.map((listed) => [listed.asset.ref, listed.last_scan]);

  it("answers each repo's newest Guard Scan as last_scan, and null for a repo no Scan names", async () => {
    const team = await teamWithMember();
    await linkRepos(repoAssets, team, [repoRef("web"), repoRef("api")]);
    const scan = await queueGuardScan(team, ["web"]);

    const res = await readRepos(team);

    expect(res.status).toBe(200);
    expect(lastScans(res.body)).toEqual([
      [repoRef("api"), null],
      [repoRef("web"), scan],
    ]);
  });

  it("never shows Team A's Scan of a ref to Team B, which lists the same ref (story 15)", async () => {
    const teamA = await teamWithMember();
    const teamB = await teamWithMember();
    await linkRepos(repoAssets, teamA, [repoRef("shared")]);
    await linkRepos(repoAssets, teamB, [repoRef("shared")]);
    await queueGuardScan(teamA, ["shared"]);

    const res = await readRepos(teamB);

    expect(lastScans(res.body)).toEqual([[repoRef("shared"), null]]);
  });

  it("answers a Guard Scan queued 16 minutes ago and never started as failed with an ended_at, and stores it so", async () => {
    const team = await teamWithMember();
    await linkRepos(repoAssets, team, [repoRef("web")]);
    const { id } = await queueGuardScan(team, ["web"]);
    await withTeam(team, (tx) =>
      sql`update scan_requests set queued_at = now() - interval '16 minutes' where id = ${id}`.execute(
        tx,
      ),
    );

    const res = await readRepos(team);

    const last = ScanBody.parse(ReposBody.parse(res.body).repos[0]!.last_scan);
    expect(last).toMatchObject({ id, state: "failed", started_at: null });
    expect(last.ended_at).toEqual(expect.any(String));
    const stored = await withTeam(team, (tx) =>
      tx.selectFrom("scan_requests").selectAll().where("id", "=", id).executeTakeFirstOrThrow(),
    );
    expect(stored.state).toBe("failed");
    expect(stored.ended_at!.getTime()).toBe(
      stored.queued_at.getTime() + QUEUED_SCAN_LIMIT_MINUTES * 60_000,
    );
  });

  it("answers last_scan: null for each repo when Guard's routes are built without scans", async () => {
    const team = await teamWithMember();
    await linkRepos(repoAssets, team, [repoRef("web")]);
    await queueGuardScan(team, ["web"]);

    const res = await readRepos(team, { withScans: false });

    expect(lastScans(res.body)).toEqual([[repoRef("web"), null]]);
  });
});
