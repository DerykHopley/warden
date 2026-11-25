// Story 1 at the API: an Admin's Setup page asks `GET /api/github/app` for what GitHub's links are built from, the
// App's slug and client id. Through the real app with Guard's routes and the real GitHub client, GitHub faked at
// `fetch` (spec decision 11), on the suite's shared database. The slug is read from GitHub once per instance; a failed
// read isn't kept.
import { GitHubAppBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Fetch } from "../src/http-call.ts";
import { createLogger } from "../src/log.ts";
import { createGitHub } from "../src/modules/guard/github.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  newTeam,
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

const CLIENT_ID = "Iv23li-the-client-id";
const SLUG = "warden-reader";
const LEAD = "user_lead";
const MEMBER = "user_member";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type AppAnswer = () => Response;
const app200: AppAnswer = () => json({ id: 1, slug: SLUG, name: "Warden reader" });

/** A fake GitHub whose `GET /app` answers each call with the next of `answers` (the last one repeats), counting calls. */
function fakeGitHub(...answers: AppAnswer[]) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const { origin, pathname } = new URL(url);
    const route = `${init.method ?? "GET"} ${origin}${pathname}`;
    calls.push(route);
    if (route !== "GET https://api.github.com/app") throw new Error(`unexpected call to ${route}`);
    const answer = answers[Math.min(calls.length, answers.length) - 1] ?? app200;
    return answer();
  };
  const github = createGitHub({
    clientId: CLIENT_ID,
    clientSecret: "the-client-secret-value",
    privateKey: gitHubAppKey(),
    fetch,
  });
  return { github, calls };
}

/** The app with Guard's routes, reading through `github` (none: GitHub isn't set up), and every log line it writes. */
function githubApp(github?: ReturnType<typeof fakeGitHub>["github"]) {
  const guardLines: string[] = [];
  const logger = createLogger((line) => guardLines.push(line));
  const routes = github ? guardRoutes({ repoAssets, github, logger }) : guardRoutes({ repoAssets });
  const { app, lines } = testApp({ publicPem, withTeam, moduleRoutes: [routes] });
  return { app, logLines: () => [...lines, ...guardLines] };
}

type App = ReturnType<typeof githubApp>["app"];

async function askApp(app: App, team: string, as = ADMIN) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request("/api/github/app", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("GET /api/github/app: what an Admin's Setup builds GitHub's links from (story 1)", () => {
  it("answers an Admin 200 with the configured client id and GitHub's slug, asking GitHub once for two calls", async () => {
    const team = await newTeam(withTeam);
    const { github, calls } = fakeGitHub();
    const { app } = githubApp(github);

    const first = await askApp(app, team);
    const second = await askApp(app, team);

    expect(first.status).toBe(200);
    expect(GitHubAppBody.parse(first.body)).toEqual({ slug: SLUG, client_id: CLIENT_ID });
    expect(second).toEqual(first);
    expect(calls).toEqual(["GET https://api.github.com/app"]);
  });

  it.each([
    ["a Lead", LEAD],
    ["a Member", MEMBER],
  ])("answers %s 403 without calling GitHub", async (_name, person) => {
    const team = await newTeam(withTeam, [
      [ADMIN, "admin"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    const { github, calls } = fakeGitHub();
    const { app } = githubApp(github);

    expect((await askApp(app, team, person)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("answers 503 when GitHub isn't set up here", async () => {
    const team = await newTeam(withTeam);
    const { app } = githubApp();

    expect(await askApp(app, team)).toEqual({
      status: 503,
      body: { error: "GitHub isn't set up here" },
    });
  });

  it.each([
    ["answers 500", 500, () => json({ message: "Server Error" }, 500)],
    ["answers with no slug", 200, () => json({ id: 1, name: "Warden reader" })],
  ])(
    "answers 502 when GitHub %s, logs the step and status only, and asks GitHub again next time",
    async (_name, status, failing) => {
      const team = await newTeam(withTeam);
      const { github, calls } = fakeGitHub(failing, app200);
      const { app, logLines } = githubApp(github);

      const failed = await askApp(app, team);
      const next = await askApp(app, team);

      expect(failed).toEqual({ status: 502, body: { error: "GitHub didn't answer" } });
      const entries = logLines().map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = entries.find((e) => e.step === "GitHub's authenticated app");
      expect(entry).toMatchObject({ severity: "ERROR", status });
      // GitHub's own words aren't repeated.
      expect(JSON.stringify(entry)).not.toContain("Server Error");
      expect(next).toEqual({ status: 200, body: { slug: SLUG, client_id: CLIENT_ID } });
      expect(calls).toHaveLength(2);
    },
  );
});
