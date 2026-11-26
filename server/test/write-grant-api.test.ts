// Stories 5 and 15 at the API (#224): an Admin grants write access by linking an installation of Warden's write GitHub
// app (`POST /api/github/write-installations`), checked against their own sign-in through the write app's OAuth, and
// only a token holding exactly the write app's three permissions is linked. Any person in the Team reads the grant
// (`GET /api/github/write-grant`); another Team never sees it or takes its installation. Through the real app with the
// write grant's routes, the real GitHub client and the real store, GitHub faked at `fetch` (spec decision 11), on the
// suite's shared database, each case with Teams and installation ids of its own.
import { GitHubAppBody, WriteGrantBody, WriteGrantsBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Fetch } from "../src/http-call.ts";
import { createLogger } from "../src/log.ts";
import { createGitHub, type GitHub } from "../src/modules/guard/github.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
import { writeGrantRoutes } from "../src/modules/guard/write-grant-routes.ts";
import { createWriteGrants, type WriteGrants } from "../src/modules/guard/write-grants.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  logEntries,
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
let writeGrants: WriteGrants;
let repoAssets: RepoAssets;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  writeGrants = createWriteGrants({ withTeam });
  repoAssets = createRepoAssets({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

const CLIENT_SECRET = "the-write-client-secret-value";
const CODE = "the-write-code-value";
const VERIFIER = "the-write-code-verifier-value-that-is-long-enough-for-pkce";
const USER_TOKEN = "ghu_the-write-user-token";
const INSTALLATION_TOKEN = "ghs_the-write-installation-token";
const SECRETS = [CLIENT_SECRET, CODE, VERIFIER, USER_TOKEN, INSTALLATION_TOKEN];

const WRITE_CLIENT_ID = "Iv23li-the-write-client-id";
const WRITE_SLUG = "warden-writer";
const READ_CLIENT_ID = "Iv23li-the-read-client-id";
const READ_SLUG = "warden-reader";
const WRITE_APP = { contents: "write", pull_requests: "write", metadata: "read" };

const LEAD = "user_lead";
const MEMBER = "user_member";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A fake GitHub for one app (the write app by default) and one installation: the person reaches `reachable`
 * installations; the App's installation token answer gives `permissions`, or `tokenStatus` when it's an error; `GET
 * /app` answers `slug`. `failAt` names one endpoint that answers 500; `refuse` makes the token exchange refuse the code.
 * Every call is recorded.
 */
function fakeGitHub({
  installationId = 0,
  clientId = WRITE_CLIENT_ID,
  slugs = [WRITE_SLUG],
  reachable = [installationId],
  permissions = WRITE_APP,
  tokenStatus,
  refuse = false,
  failAt,
}: {
  installationId?: number;
  clientId?: string;
  /** `GET /app`'s slug for each call in turn, the last one repeating. */
  slugs?: string[];
  reachable?: number[];
  permissions?: Record<string, string>;
  tokenStatus?: 404;
  refuse?: boolean;
  failAt?: "installations" | "app";
} = {}) {
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
        return json({
          total_count: 1,
          repositories: [{ id: 1, html_url: "https://github.com/acme/web" }],
        });
      case `POST ${api}/app/installations/${installationId}/access_tokens`:
        if (tokenStatus !== undefined) return json({ message: "Not Found" }, tokenStatus);
        return json({ token: INSTALLATION_TOKEN, permissions }, 201);
      case `GET ${api}/app`: {
        if (failAt === "app") return json({ message: "Server Error" }, 500);
        const asked = calls.filter((call) => call === route).length;
        return json({ id: 1, slug: slugs[Math.min(asked, slugs.length) - 1], name: "Warden" });
      }
      default:
        throw new Error(`unexpected call to ${route}`);
    }
  };
  const github = createGitHub({
    clientId,
    clientSecret: CLIENT_SECRET,
    privateKey: gitHubAppKey(),
    fetch,
  });
  return { github, calls };
}

/**
 * The app with the write grant's routes, linking through the write app's `github` (none: the write app isn't set up)
 * on `now`'s clock; with `readGitHub`, Guard's routes too, linking through the read app. Every log line it writes.
 */
function writeApp(
  github?: GitHub,
  { now, readGitHub }: { now?: () => number; readGitHub?: GitHub } = {},
) {
  const routeLines: string[] = [];
  const logger = createLogger((line) => routeLines.push(line));
  const routes = [
    github
      ? writeGrantRoutes({ writeGrants, github, logger, now })
      : writeGrantRoutes({ writeGrants }),
  ];
  if (readGitHub) routes.push(guardRoutes({ repoAssets, github: readGitHub, logger }));
  const { app, lines } = testApp({ publicPem, withTeam, moduleRoutes: routes });
  return { app, logLines: () => [...lines, ...routeLines] };
}

type App = ReturnType<typeof writeApp>["app"];

async function call(
  app: App,
  team: string,
  path: string,
  { as = ADMIN, body }: { as?: string; body?: unknown } = {},
) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(
    path,
    body === undefined
      ? { headers: { Authorization: `Bearer ${token}` } }
      : {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as unknown };
}

const linkBody = (installationId: number) => ({
  installation_id: installationId,
  code: CODE,
  code_verifier: VERIFIER,
});

const link = (app: App, team: string, installationId: number, as = ADMIN) =>
  call(app, team, "/api/github/write-installations", { as, body: linkBody(installationId) });

async function grantsOf(app: App, team: string, as = ADMIN) {
  const res = await call(app, team, "/api/github/write-grant", { as });
  expect(res.status).toBe(200);
  return WriteGrantsBody.parse(res.body).installations;
}

/** How many `github_write_grants` rows the Team has, read as that Team. */
const rowCount = (team: string) =>
  withTeam(team, async (tx) => {
    const { count } = await tx
      .selectFrom("github_write_grants")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(count);
  });

const teamOfThree = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);

describe("POST /api/github/write-installations: an Admin grants write access (story 5)", () => {
  it("answers 201 with the grant, and GET /api/github/write-grant then lists it where it listed none", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId }).github);
    expect(await grantsOf(app, team)).toEqual([]);

    const res = await link(app, team, installationId);

    expect(res.status).toBe(201);
    const grant = WriteGrantBody.parse(res.body);
    expect(grant).toEqual({
      installation_id: installationId,
      granted_by: ADMIN,
      granted_at: expect.any(String),
    });
    expect(await grantsOf(app, team)).toEqual([grant]);
    expect(await rowCount(team)).toBe(1);
  });

  it("adds no Repo Asset to the Team", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId }).github);

    expect((await link(app, team, installationId)).status).toBe(201);

    expect(await repoAssets.list(team)).toEqual([]);
  });

  it("answers 200 with the same grant for an installation the Team already holds, and writes no row", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId }).github);
    const first = await link(app, team, installationId);

    const again = await link(app, team, installationId);

    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 200, body: first.body });
    expect(await rowCount(team)).toBe(1);
  });

  it.each([
    ["can also write workflows", { ...WRITE_APP, workflows: "write" }],
    ["can also read administration", { ...WRITE_APP, administration: "read" }],
    ["lacks pull requests", { contents: "write", metadata: "read" }],
    ["can only read contents", { ...WRITE_APP, contents: "read" }],
    ["names no permissions", {}],
  ])(
    "answers 409 for an installation whose token %s, and writes no row",
    async (_name, permissions) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { app } = writeApp(fakeGitHub({ installationId, permissions }).github);

      const res = await link(app, team, installationId);

      expect(res).toMatchObject({
        status: 409,
        body: { error: "This installation's permissions aren't the write app's" },
      });
      expect(await rowCount(team)).toBe(0);
    },
  );

  it("answers 503 without the write app's settings, and writes no row", async () => {
    const team = await newTeam(withTeam);
    const { app } = writeApp();

    const res = await link(app, team, newInstallation());

    expect(res).toMatchObject({
      status: 503,
      body: { error: "Fix PRs aren't set up on this Warden" },
    });
    expect(await rowCount(team)).toBe(0);
  });

  it("answers 400 naming the field for a bad body, without calling GitHub", async () => {
    const team = await newTeam(withTeam);
    const { github, calls } = fakeGitHub();
    const { app } = writeApp(github);

    const res = await call(app, team, "/api/github/write-installations", {
      body: { ...linkBody(newInstallation()), installation_id: 0 },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/^installation_id: /);
    expect(calls).toEqual([]);
    expect(await rowCount(team)).toBe(0);
  });

  it.each([
    ["a code GitHub refuses", { refuse: true }, 400, "GitHub refused the sign-in; connect again"],
    [
      "an installation the person can't reach",
      { reachable: [] },
      403,
      "You can't reach this installation on GitHub",
    ],
    [
      "an installation the app can't reach",
      { tokenStatus: 404 as const },
      409,
      "The app can't reach this installation on GitHub; nothing was linked",
    ],
    [
      "GitHub answering 500",
      { failAt: "installations" as const },
      502,
      "GitHub didn't answer; nothing was linked",
    ],
  ])("answers %s %i, and writes no row", async (_name, fake, status, error) => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId, ...fake }).github);

    const res = await link(app, team, installationId);

    expect(res).toMatchObject({ status, body: { error } });
    expect(await rowCount(team)).toBe(0);
  });

  it("logs the step and status only when GitHub answers 500", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app, logLines } = writeApp(
      fakeGitHub({ installationId, failAt: "installations" }).github,
    );

    await link(app, team, installationId);

    const entry = logEntries(logLines().join("\n")).find((e) => e.step !== undefined);
    expect(entry).toMatchObject({
      severity: "ERROR",
      team,
      step: "GitHub's list of the user's installations",
      status: 500,
    });
    expect(JSON.stringify(entry)).not.toContain("Server Error");
  });

  it("answers a Team's 11th link in an hour 429 with Retry-After, without calling GitHub, and writes no row", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { github, calls } = fakeGitHub({ installationId, refuse: true });
    const { app } = writeApp(github);
    for (let i = 0; i < 10; i++) {
      expect((await link(app, team, installationId)).status).toBe(400);
    }
    const callsBefore = calls.length;

    const res = await link(app, team, installationId);

    expect(res).toMatchObject({
      status: 429,
      body: { error: "A Team links at most 10 times an hour" },
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(callsBefore);
    expect(await rowCount(team)).toBe(0);
  });

  it("counts the write app's links apart from the read app's: a Team at the read app's limit still links a write installation", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId }).github, {
      readGitHub: fakeGitHub({ clientId: READ_CLIENT_ID, refuse: true }).github,
    });
    const readLink = () =>
      call(app, team, "/api/github/installations", { body: linkBody(newInstallation()) });
    for (let i = 0; i < 10; i++) expect((await readLink()).status).toBe(400);
    expect((await readLink()).status).toBe(429);

    expect((await link(app, team, installationId)).status).toBe(201);
  });

  it.each([
    ["a Lead", LEAD],
    ["a Member", MEMBER],
  ])(
    "answers %s 403 on both Admin routes without calling GitHub, and 200 on the grant",
    async (_name, person) => {
      const team = await teamOfThree();
      const installationId = newInstallation();
      const { github, calls } = fakeGitHub({ installationId });
      const { app } = writeApp(github);
      const granted = await writeGrants.grant(team, { installationId, grantedBy: ADMIN });

      expect((await link(app, team, installationId, person)).status).toBe(403);
      expect((await call(app, team, "/api/github/write-app", { as: person })).status).toBe(403);
      expect(calls).toEqual([]);
      expect(await grantsOf(app, team, person)).toEqual([
        {
          installation_id: installationId,
          granted_by: ADMIN,
          granted_at: granted.grantedAt.toISOString(),
        },
      ]);
    },
  );
});

describe("GET /api/github/write-app: the write app's Connect step", () => {
  it("answers the write app's slug and client id, never the read app's, asking GitHub at most once an hour", async () => {
    const team = await newTeam(withTeam);
    const write = fakeGitHub({ slugs: [WRITE_SLUG, "warden-writer-renamed"] });
    const read = fakeGitHub({ clientId: READ_CLIENT_ID, slugs: [READ_SLUG] });
    let now = Date.parse("2026-11-26T09:00:00Z");
    const { app } = writeApp(write.github, { now: () => now, readGitHub: read.github });

    const first = await call(app, team, "/api/github/write-app");
    now += 3_600_000 - 1;
    const withinTheHour = await call(app, team, "/api/github/write-app");
    now += 1;
    const afterIt = await call(app, team, "/api/github/write-app");

    expect(first.status).toBe(200);
    expect(GitHubAppBody.parse(first.body)).toEqual({
      slug: WRITE_SLUG,
      client_id: WRITE_CLIENT_ID,
    });
    expect(withinTheHour.body).toEqual(first.body);
    expect(afterIt.body).toEqual({ slug: "warden-writer-renamed", client_id: WRITE_CLIENT_ID });
    expect(write.calls).toEqual([
      "GET https://api.github.com/app",
      "GET https://api.github.com/app",
    ]);
    expect(read.calls).toEqual([]);
  });

  it("answers 503 without the write app's settings", async () => {
    const team = await newTeam(withTeam);
    const { app } = writeApp();

    expect(await call(app, team, "/api/github/write-app")).toMatchObject({
      status: 503,
      body: { error: "Fix PRs aren't set up on this Warden" },
    });
  });

  it("answers 502 when GitHub answers 500, logs the step and status only, and asks again next time", async () => {
    const team = await newTeam(withTeam);
    const { github, calls } = fakeGitHub({ failAt: "app" });
    const { app, logLines } = writeApp(github);

    const failed = await call(app, team, "/api/github/write-app");
    await call(app, team, "/api/github/write-app");

    expect(failed).toMatchObject({ status: 502, body: { error: "GitHub didn't answer" } });
    const entry = logEntries(logLines().join("\n")).find((e) => e.step !== undefined);
    expect(entry).toMatchObject({
      severity: "ERROR",
      step: "GitHub's authenticated app",
      status: 500,
    });
    expect(JSON.stringify(entry)).not.toContain("Server Error");
    expect(calls).toHaveLength(2);
  });
});

describe("GET /api/github/write-grant", () => {
  it("answers { installations: [] } without the write app's settings", async () => {
    const team = await newTeam(withTeam);
    const { app } = writeApp();

    expect(await grantsOf(app, team)).toEqual([]);
  });
});

describe("another Team never sees or takes the write grant (story 15)", () => {
  it("lists Team B none while Team A holds a grant, and answers Team B's link of Team A's installation 409, writing nothing", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = writeApp(fakeGitHub({ installationId }).github);
    const granted = await link(app, teamA, installationId);
    expect(granted.status).toBe(201);

    expect(await grantsOf(app, teamB)).toEqual([]);
    const res = await link(app, teamB, installationId);

    expect(res).toMatchObject({
      status: 409,
      body: { error: "This write installation is linked to another Team" },
    });
    expect(await rowCount(teamB)).toBe(0);
    expect(await grantsOf(app, teamB)).toEqual([]);
    expect(await grantsOf(app, teamA)).toEqual([granted.body]);
  });
});

describe("no secret in an answer or a log line", () => {
  it.each([
    ["a successful link", {}],
    ["a second link of a held grant", {}, true],
    ["a refused code", { refuse: true }],
    ["an installation the person can't reach", { reachable: [] }],
    ["an installation the app can't reach", { tokenStatus: 404 as const }],
    ["GitHub answering 500", { failAt: "installations" as const }],
    [
      "a token with more than the write app's permissions",
      { permissions: { ...WRITE_APP, workflows: "write" } },
    ],
  ])(
    "holds no client secret, code, verifier or token, for %s",
    async (_name, fake, twice = false) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { app, logLines } = writeApp(fakeGitHub({ installationId, ...fake }).github);

      const answers = [await link(app, team, installationId)];
      if (twice) answers.push(await link(app, team, installationId));

      const log = logLines().join("\n");
      expect(log).not.toBe("");
      for (const secret of SECRETS) {
        expect(log).not.toContain(secret);
        for (const answer of answers) expect(answer.text).not.toContain(secret);
      }
    },
  );

  it("holds none for a link of another Team's installation, nor for the 429", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app, logLines } = writeApp(fakeGitHub({ installationId }).github);
    await link(app, teamA, installationId);

    const answers = [];
    for (let i = 0; i < 11; i++) answers.push(await link(app, teamB, installationId));

    expect(answers.map((answer) => answer.status)).toEqual([...Array(10).fill(409), 429]);
    const log = logLines().join("\n");
    for (const secret of SECRETS) {
      expect(log).not.toContain(secret);
      for (const answer of answers) expect(answer.text).not.toContain(secret);
    }
  });
});
