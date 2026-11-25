// Story 1's list at the API, and story 15 for it: any person in a Team reads its Repo Assets (`GET /api/repos`), and
// another Team never sees them. Through the real app with Guard's routes, on the suite's shared database, each case
// with Teams and installation ids of its own.
import { ReposBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
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

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  repoAssets = createRepoAssets({ withTeam });
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

async function readRepos(team: string, as = MEMBER) {
  const { app } = testApp({ publicPem, withTeam, moduleRoutes: [guardRoutes({ repoAssets })] });
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request("/api/repos", { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
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
        },
        {
          asset: { kind: "repo", ref: repoRef("web") },
          installation_id: installationId,
          listed_at: expect.any(String),
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
      },
    ]);
  });
});
