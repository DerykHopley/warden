// Stories 1 and 15 at the API: an Admin links a GitHub installation to their Team (`POST /api/github/installations`),
// checked against their own GitHub sign-in, and only the repos they can read become Repo Assets. Through the real app
// with Guard's routes and the real GitHub client, GitHub faked at `fetch` (spec decision 11), on the suite's shared
// database, each case with Teams and installation ids of its own.
import { generateKeyPairSync } from "node:crypto";
import { LinkedInstallationBody, ReposBody } from "@warden/contracts";
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
  newInstallation,
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

const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const CLIENT_SECRET = "the-client-secret-value";
const CODE = "the-code-value";
const VERIFIER = "the-code-verifier-value-that-is-long-enough-for-pkce";
const USER_TOKEN = "ghu_the-user-token";
const INSTALLATION_TOKEN = "ghs_the-installation-token";
const SECRETS = [CLIENT_SECRET, CODE, VERIFIER, USER_TOKEN, INSTALLATION_TOKEN];

const LEAD = "user_lead";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const githubRepo = (name: string, id: number) => ({
  id,
  html_url: `https://github.com/acme/${name}`,
});

/**
 * A fake GitHub for one installation: the person reaches `reachable` installations and reads `userRepos` in it; the
 * App's installation token lists `appRepos` with `permissions`. `failAt` names one endpoint that answers 500; `refuse`
 * makes the token exchange refuse the code. Every call is recorded.
 */
function fakeGitHub({
  installationId,
  reachable = [installationId],
  userRepos = [githubRepo("web", 1)],
  appRepos = [githubRepo("web", 1), githubRepo("secret", 2)],
  permissions = { contents: "read", metadata: "read" },
  refuse = false,
  failAt,
}: {
  installationId: number;
  reachable?: number[];
  userRepos?: ReturnType<typeof githubRepo>[];
  appRepos?: ReturnType<typeof githubRepo>[];
  permissions?: Record<string, string>;
  refuse?: boolean;
  failAt?: "installations";
}) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const { origin, pathname } = new URL(url);
    const route = `${init.method ?? "GET"} ${origin}${pathname}`;
    calls.push(route);
    const api = "https://api.github.com";
    switch (route) {
      case "POST https://github.com/login/oauth/access_token":
        return refuse
          ? json({ error: "bad_verification_code" })
          : json({ access_token: USER_TOKEN, token_type: "bearer" });
      case `GET ${api}/user/installations`:
        if (failAt === "installations") return json({ message: "Server Error" }, 500);
        return json({
          total_count: reachable.length,
          installations: reachable.map((id) => ({ id })),
        });
      case `GET ${api}/user/installations/${installationId}/repositories`:
        return json({ total_count: userRepos.length, repositories: userRepos });
      case `POST ${api}/app/installations/${installationId}/access_tokens`:
        return json({ token: INSTALLATION_TOKEN, permissions }, 201);
      case `GET ${api}/installation/repositories`:
        return json({ total_count: appRepos.length, repositories: appRepos });
      default:
        throw new Error(`unexpected call to ${route}`);
    }
  };
  const github = createGitHub({
    clientId: "Iv23li-the-client-id",
    clientSecret: CLIENT_SECRET,
    privateKey: PRIVATE_KEY,
    fetch,
  });
  return { github, calls };
}

/** The app with Guard's routes, linking through `github` (none: GitHub isn't set up), and every log line it writes. */
function linkApp(github?: ReturnType<typeof fakeGitHub>["github"]) {
  const guardLines: string[] = [];
  const logger = createLogger((line) => guardLines.push(line));
  const routes = github ? guardRoutes({ repoAssets, github, logger }) : guardRoutes({ repoAssets });
  const { app, lines } = testApp({ publicPem, withTeam, moduleRoutes: [routes] });
  return { app, logLines: () => [...lines, ...guardLines] };
}

type App = ReturnType<typeof linkApp>["app"];

async function link(app: App, team: string, body: unknown, as = ADMIN) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request("/api/github/installations", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as unknown };
}

const linkBody = (installationId: number) => ({
  installation_id: installationId,
  code: CODE,
  code_verifier: VERIFIER,
});

async function reposOf(app: App, team: string) {
  const token = await sessionToken(key, ADMIN, 60, activeOrganization(team));
  const res = await app.request("/api/repos", { headers: { Authorization: `Bearer ${token}` } });
  return ReposBody.parse(await res.json()).repos.map((repo) => [
    repo.asset.ref,
    repo.installation_id,
  ]);
}

const teamWithLead = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
  ]);

describe("POST /api/github/installations: an Admin links an installation (stories 1 and 15)", () => {
  it("answers 201 with only the repos the Admin's own token lists, not the App's wider list, and GET /api/repos lists exactly those", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { github } = fakeGitHub({ installationId });
    const { app } = linkApp(github);

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    expect(LinkedInstallationBody.parse(res.body)).toEqual({
      installation_id: installationId,
      repos: [
        {
          asset: { kind: "repo", ref: "https://github.com/acme/web" },
          installation_id: installationId,
          listed_at: expect.any(String),
        },
      ],
    });
    expect(await reposOf(app, team)).toEqual([["https://github.com/acme/web", installationId]]);
  });

  it("links an installation the Admin reads no repo in with repos: []", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId, userRepos: [] }).github);

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 201,
      body: { installation_id: installationId, repos: [] },
    });
  });

  it("replaces the installation's repos with what this person reads when linked again", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    await link(linkApp(fakeGitHub({ installationId }).github).app, team, linkBody(installationId));
    const { app } = linkApp(
      fakeGitHub({ installationId, userRepos: [githubRepo("api", 3)] }).github,
    );

    expect((await link(app, team, linkBody(installationId))).status).toBe(201);

    expect(await reposOf(app, team)).toEqual([["https://github.com/acme/api", installationId]]);
  });

  it("answers 403 for an installation the person can't reach, and links nothing", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { github, calls } = fakeGitHub({ installationId, reachable: [installationId + 1] });
    const { app } = linkApp(github);

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 403,
      body: { error: "You can't reach this installation on GitHub" },
    });
    expect(calls.some((call) => call.includes("access_tokens"))).toBe(false);
    expect(await reposOf(app, team)).toEqual([]);
  });

  it("answers 400 for a code GitHub refuses, and links nothing", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId, refuse: true }).github);

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 400,
      body: { error: "GitHub refused the sign-in; connect again" },
    });
    expect(await reposOf(app, team)).toEqual([]);
  });

  it("answers 502 when GitHub answers 500, links nothing, and logs the step and status", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app, logLines } = linkApp(
      fakeGitHub({ installationId, failAt: "installations" }).github,
    );

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 502,
      body: { error: "GitHub didn't answer; nothing was linked" },
    });
    expect(await reposOf(app, team)).toEqual([]);
    const entries = logLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        step: "GitHub's list of the user's installations",
        status: 500,
      }),
    );
  });

  it("answers 409 for an installation whose token can write contents, and links nothing", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(
      fakeGitHub({ installationId, permissions: { contents: "write", metadata: "read" } }).github,
    );

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 409,
      body: { error: "This installation can do more than read" },
    });
    expect(await reposOf(app, team)).toEqual([]);
  });

  it("answers Team B's Admin 409 for Team A's installation, and Team A's repos are unchanged", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId }).github);
    await link(app, teamA, linkBody(installationId));
    const { app: appB } = linkApp(
      fakeGitHub({ installationId, userRepos: [githubRepo("other", 9)] }).github,
    );

    const res = await link(appB, teamB, linkBody(installationId));

    expect(res).toMatchObject({
      status: 409,
      body: { error: "This installation is linked to another Team" },
    });
    expect(await reposOf(app, teamA)).toEqual([["https://github.com/acme/web", installationId]]);
    expect(await reposOf(app, teamB)).toEqual([]);
  });

  it("answers a Lead 403 without calling GitHub", async () => {
    const team = await teamWithLead();
    const installationId = newInstallation();
    const { github, calls } = fakeGitHub({ installationId });
    const { app } = linkApp(github);

    const res = await link(app, team, linkBody(installationId), LEAD);

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(await reposOf(app, team)).toEqual([]);
  });

  it("answers 503 when GitHub isn't set up here", async () => {
    const team = await newTeam(withTeam);
    const { app } = linkApp();

    const res = await link(app, team, linkBody(newInstallation()));

    expect(res).toMatchObject({ status: 503, body: { error: "GitHub isn't set up here" } });
  });

  it.each([
    ["a code_verifier under 43 characters", { code_verifier: "x".repeat(42) }, "code_verifier"],
    ["a code_verifier over 128 characters", { code_verifier: "x".repeat(129) }, "code_verifier"],
    ["an empty code", { code: "" }, "code"],
    ["an installation id that isn't a positive integer", { installation_id: 0 }, "installation_id"],
  ])(
    "answers 400 naming the field for %s, without calling GitHub",
    async (_name, change, field) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { github, calls } = fakeGitHub({ installationId });
      const { app } = linkApp(github);

      const res = await link(app, team, { ...linkBody(installationId), ...change });

      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(new RegExp(`^${field}: `));
      expect(calls).toEqual([]);
    },
  );

  it("answers a Team's 11th link attempt in an hour 429 with Retry-After, without calling GitHub, while another Team's first goes through", async () => {
    const team = await newTeam(withTeam);
    const other = await newTeam(withTeam);
    const installationId = newInstallation();
    const { github, calls } = fakeGitHub({ installationId, refuse: true });
    const { app } = linkApp(github);
    for (let i = 0; i < 10; i++) {
      expect((await link(app, team, linkBody(installationId))).status).toBe(400);
    }
    const callsBefore = calls.length;

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 429,
      body: { error: "A Team links at most 10 times an hour" },
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(callsBefore);
    expect((await link(app, other, linkBody(installationId))).status).toBe(400);
    expect(calls.length).toBeGreaterThan(callsBefore);
  });

  it.each([
    ["a successful link", {}],
    ["a refused code", { refuse: true }],
    ["GitHub answering 500", { failAt: "installations" as const }],
    ["an installation that can write", { permissions: { contents: "write" } }],
  ])(
    "writes no log line holding a code, verifier, secret or token, for %s",
    async (_name, fake) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { app, logLines } = linkApp(fakeGitHub({ installationId, ...fake }).github);

      await link(app, team, linkBody(installationId));

      const log = logLines().join("\n");
      expect(log).not.toBe("");
      for (const secret of SECRETS) expect(log).not.toContain(secret);
    },
  );
});
