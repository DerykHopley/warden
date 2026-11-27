// Stories 1 and 15 at the API: an Admin links a GitHub installation to their Team (`POST /api/github/installations`),
// checked against their own GitHub sign-in, and only the repos they can read become Repo Assets. Through the real app
// with Guard's routes and the real GitHub client, GitHub faked at `fetch` (spec decision 11), on the suite's shared
// database, each case with Teams and installation ids of its own.
import { randomUUID } from "node:crypto";
import { LinkedInstallationBody, ReposBody, ScanBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Fetch } from "../src/http-call.ts";
import { createLogger } from "../src/log.ts";
import { DEFAULT_PACK_RULE_IDS } from "../src/modules/guard/default-pack.ts";
import { createGitHub } from "../src/modules/guard/github.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { guardRoutes } from "../src/modules/guard/routes.ts";
import {
  createScans,
  SCANS_PER_HOUR,
  ScanJobStartUnknown,
  type ScanJobStarter,
  type Scans,
} from "../src/scans.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  logEntries,
  newInstallation,
  newTeam,
  seedTeam,
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

/** The App's own list of an installation's repos: wider than the person's, and never read by a link. */
const APP_REPOS_URL = "https://api.github.com/installation/repositories";

/**
 * A fake GitHub for one installation: the person reaches `reachable` installations and reads `userRepos` in it; the
 * App's installation token answer gives `permissions` ("omitted": none), or `tokenStatus` when it's an error, and the
 * App's list holds `appRepos`. `failAt` names one endpoint that answers 500; `refuse` makes the token exchange refuse
 * the code; the user token's revoke answers `revokeStatus` (204 by default). Every call is recorded.
 */
function fakeGitHub({
  installationId,
  reachable = [installationId],
  userRepos = [githubRepo("web", 1)],
  appRepos = [githubRepo("web", 1), githubRepo("secret", 2)],
  permissions = { contents: "read", metadata: "read" },
  tokenStatus,
  refuse = false,
  failAt,
  revokeStatus = 204,
}: {
  installationId: number;
  reachable?: number[];
  userRepos?: ReturnType<typeof githubRepo>[];
  appRepos?: ReturnType<typeof githubRepo>[];
  permissions?: Record<string, string> | "omitted";
  tokenStatus?: 403 | 404;
  refuse?: boolean;
  failAt?: "installations";
  revokeStatus?: 204 | 422;
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
      case `GET ${api}/user/installations/${installationId}/repositories`: {
        // GitHub's pages of 100, as the client asks for them.
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return json({
          total_count: userRepos.length,
          repositories: userRepos.slice((page - 1) * 100, page * 100),
        });
      }
      case `POST ${api}/app/installations/${installationId}/access_tokens`:
        if (tokenStatus !== undefined) return json({ message: "Not Found" }, tokenStatus);
        return json(
          permissions === "omitted"
            ? { token: INSTALLATION_TOKEN }
            : { token: INSTALLATION_TOKEN, permissions },
          201,
        );
      case `GET ${APP_REPOS_URL}`:
        return json({ total_count: appRepos.length, repositories: appRepos });
      case `DELETE ${api}/applications/${CLIENT_ID}/token`:
        return revokeStatus === 204
          ? new Response(null, { status: 204 })
          : json({ message: "Validation Failed" }, revokeStatus);
      default:
        throw new Error(`unexpected call to ${route}`);
    }
  };
  const github = createGitHub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    privateKey: gitHubAppKey(),
    fetch,
  });
  return { github, calls };
}

/**
 * The app with Guard's routes, linking through `github` (none: GitHub isn't set up) into `assets` (the suite's Repo
 * Assets by default), with `start`'s Scans and Scan Job starter for the first Scan after a link (none by default), and
 * every log line it writes.
 */
function linkApp(
  github?: ReturnType<typeof fakeGitHub>["github"],
  assets = repoAssets,
  start: { scans?: Scans; startScanJob?: ScanJobStarter } = {},
) {
  const guardLines: string[] = [];
  const logger = createLogger((line) => guardLines.push(line));
  const routes = github
    ? guardRoutes({ repoAssets: assets, github, logger, ...start })
    : guardRoutes({ repoAssets: assets, ...start });
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
    const { github, calls } = fakeGitHub({ installationId });
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
      // No Scans or starter given here, so no Scan is started.
      scan: null,
    });
    expect(await reposOf(app, team)).toEqual([["https://github.com/acme/web", installationId]]);
    // The permissions come from the installation token's answer alone: the App's list is never read.
    expect(calls).not.toContain(`GET ${APP_REPOS_URL}`);
  });

  it("answers 201 with the repos this link wrote, even when another installation links one of them before the answer", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const other = newInstallation();
    // Another Admin's link of a second installation listing the same repo lands just after this one's write.
    const racing: RepoAssets = {
      ...repoAssets,
      async link(linkTeam, input) {
        const written = await repoAssets.link(linkTeam, input);
        await repoAssets.link(linkTeam, { ...input, installationId: other });
        return written;
      },
    };
    const { app } = linkApp(fakeGitHub({ installationId }).github, racing);

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    expect(LinkedInstallationBody.parse(res.body).repos).toEqual([
      {
        asset: { kind: "repo", ref: "https://github.com/acme/web" },
        installation_id: installationId,
        listed_at: expect.any(String),
      },
    ]);
  });

  it("links an installation the Admin reads no repo in with repos: []", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId, userRepos: [] }).github);

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({
      status: 201,
      body: { installation_id: installationId, repos: [], scan: null },
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
        app: "read",
        step: "GitHub's list of the user's installations",
        status: 500,
      }),
    );
  });

  it("answers 201 and links the installation when GitHub answers the user token's revoke 422, logging one warning with the team, app, step and status and answering no secret (#147)", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { github, calls } = fakeGitHub({ installationId, revokeStatus: 422 });
    const { app, logLines } = linkApp(github);

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    expect(LinkedInstallationBody.parse(res.body).installation_id).toBe(installationId);
    expect(await reposOf(app, team)).toEqual([["https://github.com/acme/web", installationId]]);
    expect(calls).toContain(`DELETE https://api.github.com/applications/${CLIENT_ID}/token`);
    const warnings = logEntries(logLines().join("")).filter(
      (entry) => entry.severity === "WARNING",
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        team,
        app: "read",
        step: "GitHub's revoke of the user token",
        status: 422,
      }),
    ]);
    // The log half lives in "writes no log line holding a code, verifier, secret or token".
    for (const secret of [USER_TOKEN, CODE, VERIFIER, CLIENT_SECRET]) {
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
  });

  it.each([
    ["can write contents", { contents: "write", metadata: "read" }],
    // Fails closed: permissions GitHub doesn't name aren't taken as read-only.
    ["names no permissions", "omitted" as const],
    ["names an empty set of permissions", {}],
  ])(
    "answers 409 for an installation whose token %s, and links nothing",
    async (_name, permissions) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { app } = linkApp(fakeGitHub({ installationId, permissions }).github);

      const res = await link(app, team, linkBody(installationId));

      expect(res).toMatchObject({
        status: 409,
        body: { error: "This installation can do more than read" },
      });
      expect(await reposOf(app, team)).toEqual([]);
    },
  );

  it.each([
    ["403, as for a suspended installation", 403 as const],
    ["404, as for a removed installation", 404 as const],
  ])(
    "answers 409 when GitHub answers the App's token call %s, and links nothing",
    async (_name, tokenStatus) => {
      const team = await newTeam(withTeam);
      const installationId = newInstallation();
      const { app } = linkApp(fakeGitHub({ installationId, tokenStatus }).github);

      const res = await link(app, team, linkBody(installationId));

      expect(res).toMatchObject({
        status: 409,
        body: { error: "The app can't reach this installation on GitHub; nothing was linked" },
      });
      expect(await reposOf(app, team)).toEqual([]);
    },
  );

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

  it("counts Teams whose ids differ only in case apart", async () => {
    // Clerk's Organization ids are case-sensitive, so these are two Teams.
    const id = randomUUID();
    const upper = `org_A${id}`;
    const lower = `org_a${id}`;
    await seedTeam(withTeam, upper, [[ADMIN, "admin"]]);
    await seedTeam(withTeam, lower, [[ADMIN, "admin"]]);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId, refuse: true }).github);
    for (let i = 0; i < 10; i++) await link(app, upper, linkBody(installationId));

    expect((await link(app, lower, linkBody(installationId))).status).toBe(400);
  });

  it.each([
    ["a successful link", {}],
    ["a refused code", { refuse: true }],
    ["GitHub answering 500", { failAt: "installations" as const }],
    ["an installation that can write", { permissions: { contents: "write" } }],
    ["a revoke GitHub answers 422", { revokeStatus: 422 as const }],
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

const MEMBER = "user_member";

/** A starter that records each call and starts nothing, or throws `error` after recording it. */
function recordingStarter(error?: Error) {
  const calls: { scanId: string; team: string }[] = [];
  const start: ScanJobStarter = async (input) => {
    calls.push(input);
    if (error) throw error;
  };
  return { calls, start };
}

/** One of the Team's Scans, as its Member reads it. */
async function scanAsMember(app: App, team: string, id: string) {
  const token = await sessionToken(key, MEMBER, 60, activeOrganization(team));
  const res = await app.request(`/api/scans/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ScanBody.parse(await res.json());
}

const scanCount = (team: string) =>
  withTeam(team, async (tx) => {
    const { count } = await tx
      .selectFrom("scan_requests")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(count);
  });

const teamWithMember = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ]);

describe("POST /api/github/installations: the first Scan after a link (story 2)", () => {
  it("queues a Guard Scan of the linked repos, sorted by ref, with the Default Pack's Rules, as the Admin, and starts its Job", async () => {
    const team = await teamWithMember();
    const installationId = newInstallation();
    const starter = recordingStarter();
    const { app } = linkApp(
      fakeGitHub({ installationId, userRepos: [githubRepo("web", 1), githubRepo("api", 2)] })
        .github,
      repoAssets,
      { scans: createScans({ withTeam }), startScanJob: starter.start },
    );

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    const { scan } = LinkedInstallationBody.parse(res.body);
    expect(scan).toMatchObject({
      module: "guard",
      state: "queued",
      assets: [
        { kind: "repo", ref: "https://github.com/acme/api" },
        { kind: "repo", ref: "https://github.com/acme/web" },
      ],
      rules: DEFAULT_PACK_RULE_IDS,
    });
    expect(starter.calls).toEqual([{ scanId: scan!.id, team }]);
    expect(await scanAsMember(app, team, scan!.id)).toEqual(scan);
    const [row] = await withTeam(team, (tx) =>
      tx.selectFrom("scan_requests").select("requested_by").execute(),
    );
    expect(row!.requested_by).toBe(ADMIN);
  });

  it("starts nothing for an installation the Admin reads no repo in, and answers scan: null", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const starter = recordingStarter();
    const { app } = linkApp(fakeGitHub({ installationId, userRepos: [] }).github, repoAssets, {
      scans: createScans({ withTeam }),
      startScanJob: starter.start,
    });

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({ status: 201, body: { repos: [], scan: null } });
    expect(starter.calls).toEqual([]);
    expect(await scanCount(team)).toBe(0);
  });

  it.each([
    ["no Scans", () => ({ startScanJob: recordingStarter().start })],
    ["no Scan Job starter", () => ({ scans: createScans({ withTeam }) })],
  ])("answers scan: null and queues nothing with %s given", async (_name, start) => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId }).github, repoAssets, start());

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({ status: 201, body: { scan: null } });
    expect(LinkedInstallationBody.parse(res.body).repos).toHaveLength(1);
    expect(await scanCount(team)).toBe(0);
  });

  it("answers scan: null and queues nothing when the Team has started its hourly limit of Scans", async () => {
    const team = await newTeam(withTeam);
    const scans = createScans({ withTeam });
    for (let i = 0; i < SCANS_PER_HOUR; i++) {
      await scans.queue(team, {
        module: "guard",
        assets: [{ kind: "repo", ref: `https://github.com/acme/earlier-${i}` }],
        rules: [...DEFAULT_PACK_RULE_IDS],
        requestedBy: ADMIN,
      });
    }
    const installationId = newInstallation();
    const starter = recordingStarter();
    const { app } = linkApp(fakeGitHub({ installationId }).github, repoAssets, {
      scans,
      startScanJob: starter.start,
    });

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({ status: 201, body: { scan: null } });
    expect(LinkedInstallationBody.parse(res.body).repos).toHaveLength(1);
    expect(starter.calls).toEqual([]);
    expect(await scanCount(team)).toBe(SCANS_PER_HOUR);
  });

  it("answers the Scan failed when its Job couldn't be started, and the Member reads it failed", async () => {
    const team = await teamWithMember();
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId }).github, repoAssets, {
      scans: createScans({ withTeam }),
      startScanJob: recordingStarter(new Error("the Job's host refused")).start,
    });

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    const { scan } = LinkedInstallationBody.parse(res.body);
    expect(scan?.state).toBe("failed");
    expect((await scanAsMember(app, team, scan!.id)).state).toBe("failed");
  });

  it("answers the Scan queued when its Job's start is unknown", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const { app } = linkApp(fakeGitHub({ installationId }).github, repoAssets, {
      scans: createScans({ withTeam }),
      startScanJob: recordingStarter(new ScanJobStartUnknown("the answer was lost")).start,
    });

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    expect(LinkedInstallationBody.parse(res.body).scan?.state).toBe("queued");
  });

  it("still answers 201 with the link's repos and scan: null when the Scan can't be queued, logging one error under the Team", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const starter = recordingStarter();
    const refusing: Scans = {
      ...createScans({ withTeam }),
      queue: () => Promise.reject(new Error("the database refused")),
    };
    const { app, logLines } = linkApp(fakeGitHub({ installationId }).github, repoAssets, {
      scans: refusing,
      startScanJob: starter.start,
    });

    const res = await link(app, team, linkBody(installationId));

    expect(res).toMatchObject({ status: 201, body: { scan: null } });
    expect(LinkedInstallationBody.parse(res.body).repos).toEqual([
      expect.objectContaining({ asset: { kind: "repo", ref: "https://github.com/acme/web" } }),
    ]);
    expect(starter.calls).toEqual([]);
    const errors = logEntries(logLines().join("")).filter((entry) => entry.severity === "ERROR");
    expect(errors).toEqual([expect.objectContaining({ team })]);
  });

  it("queues one Scan of the first 100 refs in sorted order for a link of 101 repos", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const names = Array.from({ length: 101 }, (_, i) => `repo-${String(100 - i).padStart(3, "0")}`);
    const { app } = linkApp(
      fakeGitHub({ installationId, userRepos: names.map((name, i) => githubRepo(name, i + 1)) })
        .github,
      repoAssets,
      { scans: createScans({ withTeam }), startScanJob: recordingStarter().start },
    );

    const res = await link(app, team, linkBody(installationId));

    expect(res.status).toBe(201);
    const body = LinkedInstallationBody.parse(res.body);
    expect(body.repos).toHaveLength(101);
    const sorted = names.map((name) => `https://github.com/acme/${name}`).sort();
    expect(body.scan?.assets).toEqual(sorted.slice(0, 100).map((ref) => ({ kind: "repo", ref })));
    expect(await scanCount(team)).toBe(1);
  });
});
