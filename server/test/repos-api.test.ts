// Story 1's list at the API, and story 15 for it: any person in a Team reads its Repo Assets (`GET /api/repos`), and
// another Team never sees them. Through the real app with Guard's routes, on the suite's shared database, each case
// with Teams and installation ids of its own.
import { randomInt, randomUUID } from "node:crypto";
import { ReposBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

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

const ADMIN = "user_admin";
const MEMBER = "user_member";
const url = (name: string) => `https://github.com/example/${name}`;

async function newTeam() {
  const team = `org_repos_api_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ]);
  return team;
}

/** Links a new installation listing `names` to the Team, and answers its id. */
async function linkRepos(team: string, names: string[]) {
  const installationId = randomInt(1, 2 ** 47);
  await repoAssets.link(team, {
    installationId,
    linkedBy: ADMIN,
    repos: names.map((name, i) => ({ ref: url(name), githubId: i + 1 })),
  });
  return installationId;
}

async function readRepos(team: string, as = MEMBER) {
  const { app } = testApp({ publicPem, withTeam, moduleRoutes: [guardRoutes({ repoAssets })] });
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request("/api/repos", { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("GET /api/repos: any person in the Team reads its Repo Assets (story 1)", () => {
  it("answers a Member 200 with the Team's Repo Assets, by ref, as ReposBody", async () => {
    const team = await newTeam();
    const installationId = await linkRepos(team, ["web", "api"]);

    const res = await readRepos(team);

    expect(res.status).toBe(200);
    expect(ReposBody.parse(res.body)).toEqual({
      repos: [
        {
          asset: { kind: "repo", ref: url("api") },
          installation_id: installationId,
          listed_at: expect.any(String),
        },
        {
          asset: { kind: "repo", ref: url("web") },
          installation_id: installationId,
          listed_at: expect.any(String),
        },
      ],
    });
  });

  it("answers { repos: [] } for a Team with none", async () => {
    const res = await readRepos(await newTeam());

    expect(res).toEqual({ status: 200, body: { repos: [] } });
  });

  it("never lists Team A's Repo Assets to Team B (story 15)", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    await linkRepos(teamA, ["a-only"]);
    const installationB = await linkRepos(teamB, ["b-only"]);

    const res = await readRepos(teamB);

    expect(ReposBody.parse(res.body).repos).toEqual([
      {
        asset: { kind: "repo", ref: url("b-only") },
        installation_id: installationB,
        listed_at: expect.any(String),
      },
    ]);
  });
});
