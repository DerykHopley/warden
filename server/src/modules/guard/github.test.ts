// The GitHub client over a fake fetch (spec decision 11: GitHub is faked at its HTTP boundary). A person's code becomes
// a user token, which lists the installations they can reach and, in one of them, the repos they can read; the App's
// JWT becomes an installation token, whose answer gives the installation's permissions. Every page is read. Each
// failure throws GitHubRefusedCode, GitHubInstallationUnreachable or GitHubUnavailable, and none carries the code, the
// verifier, the client secret or a token.
import { createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { gitHubAppKey, rejection } from "../../../test/helpers.ts";
import type { Fetch } from "../../http-call.ts";
import { createLogger } from "../../log.ts";
import {
  createGitHub,
  GitHubInstallationUnreachable,
  GitHubRefusedCode,
  GitHubUnavailable,
} from "./github.ts";

const PRIVATE_KEY = gitHubAppKey();

const CLIENT_ID = "Iv23li-the-client-id";
const CLIENT_SECRET = "the-client-secret-value";
const CODE = "the-code-value";
const VERIFIER = "the-code-verifier-value-that-is-long-enough-for-pkce";
const USER_TOKEN = "ghu_the-user-token";
const INSTALLATION_TOKEN = "ghs_the-installation-token";
const INSTALLATION_ID = 42;

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const INSTALLATIONS_URL = "https://api.github.com/user/installations";
const ACCESS_TOKENS_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const USER_REPOS_URL = `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories`;
const INSTALLATION_REPOS_URL = "https://api.github.com/installation/repositories";
const APP_URL = "https://api.github.com/app";
const REVOKE_URL = `https://api.github.com/applications/${CLIENT_ID}/token`;
const SLUG = "warden-reader";

const STEPS = {
  token: "GitHub's user token exchange",
  installations: "GitHub's list of the user's installations",
  userRepos: `GitHub's list of the user's repositories in installation ${INSTALLATION_ID}`,
  accessToken: `GitHub's installation token for installation ${INSTALLATION_ID}`,
  installationRepos: `GitHub's count of installation ${INSTALLATION_ID}'s repositories`,
  app: "GitHub's authenticated app",
};
const REVOKE_STEP = "GitHub's revoke of the user token";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: URL; init: RequestInit };
type Answer = (call: Call) => Promise<Response> | Response;

/** `count` items made by `item`, numbered from 1. */
const items = <T>(count: number, item: (n: number) => T) =>
  Array.from({ length: count }, (_, i) => item(i + 1));

const repo = (n: number) => ({
  id: 1000 + n,
  name: `repo-${n}`,
  full_name: `acme/repo-${n}`,
  html_url: `https://github.com/acme/repo-${n}`,
});

/** The `per_page`-sized slice of `all` that `call`'s `page` asks for. */
function page<T>(call: Call, all: T[]): T[] {
  const perPage = Number(call.url.searchParams.get("per_page") ?? 30);
  const n = Number(call.url.searchParams.get("page") ?? 1);
  return all.slice((n - 1) * perPage, n * perPage);
}

const PERMISSIONS = { contents: "read", metadata: "read" };

/** A fake GitHub: each endpoint answered by its handler, defaulting to a working one, every call recorded. */
function fakeGitHub(
  {
    token = () => json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }),
    installations = (call) =>
      json({ total_count: 2, installations: page(call, [{ id: 7 }, { id: INSTALLATION_ID }]) }),
    // The person reads one of the installation's two repos.
    userRepos = (call) => json({ total_count: 1, repositories: page(call, [repo(1)]) }),
    accessToken = () =>
      json(
        {
          token: INSTALLATION_TOKEN,
          expires_at: "2026-11-25T14:00:00Z",
          permissions: PERMISSIONS,
          repository_selection: "selected",
        },
        201,
      ),
    // The installation reaches two repos.
    installationRepos = (call) =>
      json({ total_count: 2, repositories: page(call, [repo(1), repo(2)]) }),
    app = () => json({ id: 1, slug: SLUG, name: "Warden reader", client_id: CLIENT_ID }),
    // GitHub's "Delete an app token" answers 204 No Content.
    revoke = () => new Response(null, { status: 204 }),
  }: {
    token?: Answer;
    installations?: Answer;
    userRepos?: Answer;
    accessToken?: Answer;
    installationRepos?: Answer;
    app?: Answer;
    revoke?: Answer;
  } = {},
  timeoutMs?: number,
) {
  const calls: Call[] = [];
  const routes: Record<string, Answer> = {
    [`POST ${TOKEN_URL}`]: token,
    [`GET ${INSTALLATIONS_URL}`]: installations,
    [`GET ${USER_REPOS_URL}`]: userRepos,
    [`POST ${ACCESS_TOKENS_URL}`]: accessToken,
    [`GET ${INSTALLATION_REPOS_URL}`]: installationRepos,
    [`GET ${APP_URL}`]: app,
    [`DELETE ${REVOKE_URL}`]: revoke,
  };
  const fetch: Fetch = async (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    const route = routes[`${init.method ?? "GET"} ${call.url.origin}${call.url.pathname}`];
    if (route === undefined) throw new Error(`unexpected call to ${init.method} ${url}`);
    return route(call);
  };
  const github = createGitHub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    privateKey: PRIVATE_KEY,
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { github, calls };
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const callsTo = (calls: Call[], url: string) =>
  calls.filter((call) => `${call.url.origin}${call.url.pathname}` === url);

/** An answer that never comes: it waits for the call's signal and rejects as fetch does when it fires. */
const never: Answer = ({ init }) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });

/** A connection that drops before any answer, as undici's fetch rejects. */
const dropped: Answer = () => Promise.reject(new TypeError("fetch failed"));

const serverError: Answer = () => json({ message: "Server Error" }, 500);

/** A 200 whose connection resets partway through its body, as undici's body read rejects. */
const bodyDrops: Answer = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"total_count": 1, "'));
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200 },
  );

describe("createGitHub", () => {
  const userInstallationRepos = (github: ReturnType<typeof createGitHub>) =>
    github.userInstallationRepos(CODE, VERIFIER, INSTALLATION_ID);

  describe("userInstallationRepos", () => {
    it("exchanges the code once for a user token, which lists the installations, then the repos the person reads in it", async () => {
      const { github, calls } = fakeGitHub();

      expect(await userInstallationRepos(github)).toEqual([
        { ref: "https://github.com/acme/repo-1", githubId: 1001, admin: false },
      ]);

      // The fourth call revokes the token (below).
      const [exchange, list, repos] = calls;
      expect(calls).toHaveLength(4);
      expect(exchange!.url.href).toBe(TOKEN_URL);
      expect(exchange!.init.method).toBe("POST");
      expect(header(exchange!, "Accept")).toBe("application/json");
      expect(JSON.parse(exchange!.init.body as string)).toEqual({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: CODE,
        code_verifier: VERIFIER,
      });
      expect(`${list!.url.origin}${list!.url.pathname}`).toBe(INSTALLATIONS_URL);
      expect(header(list!, "Authorization")).toBe(`Bearer ${USER_TOKEN}`);
      expect(`${repos!.url.origin}${repos!.url.pathname}`).toBe(USER_REPOS_URL);
      expect(header(repos!, "Authorization")).toBe(`Bearer ${USER_TOKEN}`);
      for (const { init } of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("answers the repos of every page the person's list of the installation's repos runs to", async () => {
      const all = items(150, repo);
      const { github, calls } = fakeGitHub({
        userRepos: (call) => json({ total_count: all.length, repositories: page(call, all) }),
      });

      const repos = await userInstallationRepos(github);

      expect(repos).toEqual(all.map((r) => ({ ref: r.html_url, githubId: r.id, admin: false })));
      const pages = callsTo(calls, USER_REPOS_URL);
      expect(pages.map(({ url }) => url.searchParams.get("page"))).toEqual(["1", "2"]);
      for (const call of pages) expect(header(call, "Authorization")).toBe(`Bearer ${USER_TOKEN}`);
    });

    it("answers whether the person is admin of each repo, from GitHub's permissions for them, and not admin where GitHub names none", async () => {
      const permissions = (admin: boolean) => ({
        admin,
        maintain: admin,
        push: true,
        triage: true,
        pull: true,
      });
      const { github } = fakeGitHub({
        userRepos: () =>
          json({
            total_count: 4,
            repositories: [
              { ...repo(1), permissions: permissions(true) },
              { ...repo(2), permissions: permissions(false) },
              repo(3),
              // A shape GitHub doesn't document counts as not admin, and still lists the repo.
              { ...repo(4), permissions: { admin: "yes" } },
            ],
          }),
      });

      expect((await userInstallationRepos(github))?.map((r) => [r.githubId, r.admin])).toEqual([
        [1001, true],
        [1002, false],
        [1003, false],
        [1004, false],
      ]);
    });

    it("answers [] for an installation the person reaches but reads no repo in", async () => {
      const { github } = fakeGitHub({
        userRepos: () => json({ total_count: 0, repositories: [] }),
      });

      expect(await userInstallationRepos(github)).toEqual([]);
    });

    it("reads every page of the person's installations to find it", async () => {
      const all = [...items(150, (id) => ({ id: id + 1000 })), { id: INSTALLATION_ID }];
      const { github, calls } = fakeGitHub({
        installations: (call) => json({ total_count: all.length, installations: page(call, all) }),
      });

      expect(await userInstallationRepos(github)).toHaveLength(1);

      const pages = callsTo(calls, INSTALLATIONS_URL).map(({ url }) => [
        url.searchParams.get("per_page"),
        url.searchParams.get("page"),
      ]);
      expect(pages).toEqual([
        ["100", "1"],
        ["100", "2"],
      ]);
    });

    it("answers undefined for an installation not in the person's list, without listing its repos", async () => {
      const { github, calls } = fakeGitHub({
        installations: () => json({ total_count: 1, installations: [{ id: 7 }] }),
      });

      expect(await userInstallationRepos(github)).toBeUndefined();

      expect(callsTo(calls, USER_REPOS_URL)).toEqual([]);
      // The exchange, the list, and the token's revoke.
      expect(calls).toHaveLength(3);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses installation id %s, which isn't a positive integer, before any call",
      async (installationId) => {
        const { github, calls } = fakeGitHub();

        const error = await rejection(github.userInstallationRepos(CODE, VERIFIER, installationId));

        expect(error).toBeInstanceOf(RangeError);
        expect(calls).toEqual([]);
      },
    );

    it.each([
      ["bad_verification_code", 200],
      ["bad_verification_code", 400],
      ["invalid_grant", 400],
    ])(
      "throws GitHubRefusedCode when GitHub's token answer names %s with status %i, and lists nothing",
      async (name, status) => {
        const { github, calls } = fakeGitHub({
          token: () =>
            json(
              {
                error: name,
                error_description: "The code passed is incorrect or expired.",
                error_uri: "https://docs.github.com/apps/troubleshooting",
              },
              status,
            ),
        });

        const error = await rejection(userInstallationRepos(github));

        expect(error).toBeInstanceOf(GitHubRefusedCode);
        expect((error as GitHubRefusedCode).error).toBe(name);
        expect(calls).toHaveLength(1);
      },
    );

    it.each([
      ["Warden's own client credentials refused", "incorrect_client_credentials", 200],
      ["Warden's callback URL refused", "redirect_uri_mismatch", 200],
      ["a 5xx naming an error", "bad_verification_code", 502],
    ])("throws GitHubUnavailable, not a refused code, for %s", async (_name, refusal, status) => {
      const { github } = fakeGitHub({ token: () => json({ error: refusal }, status) });

      const error = await rejection(userInstallationRepos(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).status).toBe(status);
      expect(error.message).toContain(refusal);
    });
  });

  describe("userInstallationRepos revokes the user token once the check is done (#147)", () => {
    /** userInstallationRepos, with every revoke failure it hands on recorded. */
    const checkRecordingRevokeFailures = (github: ReturnType<typeof createGitHub>) => {
      const failures: unknown[] = [];
      const answer = github.userInstallationRepos(CODE, VERIFIER, INSTALLATION_ID, (error) => {
        failures.push(error);
      });
      return { answer, failures };
    };
    const revokes = (calls: Call[]) => callsTo(calls, REVOKE_URL);
    const route = ({ url, init }: Call) => `${init.method ?? "GET"} ${url.origin}${url.pathname}`;

    it("sends one DELETE /applications/{client_id}/token after both lists, with Basic auth of the client id and secret and the token in its body", async () => {
      const { github, calls } = fakeGitHub();

      const { answer, failures } = checkRecordingRevokeFailures(github);

      expect(await answer).toEqual([
        { ref: "https://github.com/acme/repo-1", githubId: 1001, admin: false },
      ]);
      expect(calls.map(route)).toEqual([
        `POST ${TOKEN_URL}`,
        `GET ${INSTALLATIONS_URL}`,
        `GET ${USER_REPOS_URL}`,
        `DELETE ${REVOKE_URL}`,
      ]);
      const revoke = calls[3]!;
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      // Basic only: GitHub's docs say a Bearer header would replace the Basic credentials.
      expect(header(revoke, "Authorization")).toBe(`Basic ${basic}`);
      expect(header(revoke, "Accept")).toBe("application/vnd.github+json");
      expect(header(revoke, "X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(header(revoke, "User-Agent")).toBe("Warden");
      expect(JSON.parse(revoke.init.body as string)).toEqual({ access_token: USER_TOKEN });
      expect(revoke.init.signal).toBeInstanceOf(AbortSignal);
      expect(failures).toEqual([]);
    });

    it("revokes the token for an installation the person can't reach, and still answers undefined", async () => {
      const { github, calls } = fakeGitHub({
        installations: () => json({ total_count: 1, installations: [{ id: 7 }] }),
      });

      const { answer, failures } = checkRecordingRevokeFailures(github);

      expect(await answer).toBeUndefined();
      expect(calls.map(route).at(-1)).toBe(`DELETE ${REVOKE_URL}`);
      expect(revokes(calls)).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    it.each([
      ["installations", { installations: serverError }],
      ["userRepos", { userRepos: serverError }],
    ] as const)(
      "revokes the token when the %s list answers 500, and still throws that list's GitHubUnavailable",
      async (step, answers) => {
        const { github, calls } = fakeGitHub(answers);

        const { answer } = checkRecordingRevokeFailures(github);

        const error = await rejection(answer);
        expect(error).toBeInstanceOf(GitHubUnavailable);
        expect(error).toMatchObject({ step: STEPS[step], status: 500 });
        expect(calls.map(route).at(-1)).toBe(`DELETE ${REVOKE_URL}`);
        expect(revokes(calls)).toHaveLength(1);
      },
    );

    it("throws the list's own error, not the revoke's, when both fail", async () => {
      const { github } = fakeGitHub({ installations: serverError, revoke: serverError });

      const { answer, failures } = checkRecordingRevokeFailures(github);

      expect(await rejection(answer)).toMatchObject({ step: STEPS.installations, status: 500 });
      expect(failures).toEqual([expect.objectContaining({ step: REVOKE_STEP, status: 500 })]);
    });

    it.each([
      ["GitHub refuses the code", { token: () => json({ error: "bad_verification_code" }) }],
      ["the exchange answers 500", { token: serverError }],
      ["the exchange's connection drops", { token: dropped }],
    ])("makes no revoke call when %s", async (_name, answers) => {
      const { github, calls } = fakeGitHub(answers);

      const { answer, failures } = checkRecordingRevokeFailures(github);

      await rejection(answer);
      expect(calls.map(route)).toEqual([`POST ${TOKEN_URL}`]);
      expect(failures).toEqual([]);
    });

    it.each([
      ["answered 422", () => json({ message: "Validation Failed" }, 422), 422],
      ["answered 500", serverError, 500],
      ["timing out", never, undefined],
    ] as [string, Answer, number | undefined][])(
      "answers as it would, and hands on one GitHubUnavailable naming the revoke's step and status, for a revoke %s",
      async (_name, revoke, status) => {
        const { github } = fakeGitHub({ revoke }, 50);

        const { answer, failures } = checkRecordingRevokeFailures(github);

        expect(await answer).toEqual([
          { ref: "https://github.com/acme/repo-1", githubId: 1001, admin: false },
        ]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(GitHubUnavailable);
        expect(failures[0]).toMatchObject({ step: REVOKE_STEP, status });
      },
    );

    it("answers as it would when a revoke fails and no one is told", async () => {
      const { github } = fakeGitHub({ revoke: serverError });

      expect(await userInstallationRepos(github)).toHaveLength(1);
    });
  });

  const installationPermissions = (github: ReturnType<typeof createGitHub>) =>
    github.installationPermissions(INSTALLATION_ID);

  describe("installationPermissions", () => {
    it("sends an App JWT that verifies against the key's public half, issued by the client id", async () => {
      const { github, calls } = fakeGitHub();
      const before = Math.floor(Date.now() / 1000);

      await installationPermissions(github);

      const [tokenCall] = callsTo(calls, ACCESS_TOKENS_URL);
      expect(tokenCall!.init.method).toBe("POST");
      const jwt = /^Bearer (.+)$/.exec(header(tokenCall!, "Authorization") ?? "")?.[1];
      const { payload, protectedHeader } = await jwtVerify(jwt!, createPublicKey(PRIVATE_KEY), {
        algorithms: ["RS256"],
        issuer: CLIENT_ID,
      });
      const after = Math.floor(Date.now() / 1000);
      expect(protectedHeader.alg).toBe("RS256");
      expect(payload.iat).toBeLessThan(before);
      expect(payload.exp).toBeGreaterThan(after);
      expect(payload.exp! - after).toBeLessThanOrEqual(600);
    });

    it("answers the installation token's permissions from the token answer alone, listing no repos", async () => {
      const { github, calls } = fakeGitHub();

      expect(await installationPermissions(github)).toEqual(PERMISSIONS);

      expect(calls.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([ACCESS_TOKENS_URL]);
    });

    it.each([
      ["permissions are missing", {}],
      ["permissions are empty", { permissions: {} }],
    ])("answers no permissions when the token answer's %s", async (_name, answer) => {
      const { github } = fakeGitHub({
        accessToken: () => json({ token: INSTALLATION_TOKEN, ...answer }, 201),
      });

      expect(await installationPermissions(github)).toEqual({});
    });

    it.each([
      ["403, as for a suspended installation", 403, "This installation has been suspended"],
      ["404, as for a removed installation", 404, "Not Found"],
    ])(
      "throws GitHubInstallationUnreachable when the token call answers %s",
      async (_name, status, message) => {
        const { github } = fakeGitHub({ accessToken: () => json({ message }, status) });

        const error = await rejection(installationPermissions(github));

        expect(error).toBeInstanceOf(GitHubInstallationUnreachable);
        expect((error as GitHubInstallationUnreachable).status).toBe(status);
      },
    );

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses installation id %s, which isn't a positive integer, before any call",
      async (installationId) => {
        const { github, calls } = fakeGitHub();

        const error = await rejection(github.installationPermissions(installationId));

        expect(error).toBeInstanceOf(RangeError);
        expect(calls).toEqual([]);
      },
    );
  });

  const installationRepoCount = (github: ReturnType<typeof createGitHub>) =>
    github.installationRepoCount(INSTALLATION_ID);

  describe("installationRepoCount", () => {
    it("answers how many repos the installation reaches, GitHub's count read through the installation's own token", async () => {
      const { github, calls } = fakeGitHub();

      expect(await installationRepoCount(github)).toBe(2);

      expect(calls.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
        ACCESS_TOKENS_URL,
        INSTALLATION_REPOS_URL,
      ]);
      const [, list] = calls;
      expect(header(list!, "Authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    });

    it.each([403, 404])(
      "throws GitHubInstallationUnreachable when the token call answers %i",
      async (status) => {
        const { github } = fakeGitHub({
          accessToken: () => json({ message: "Not Found" }, status),
        });

        const error = await rejection(installationRepoCount(github));

        expect(error).toBeInstanceOf(GitHubInstallationUnreachable);
      },
    );

    it.each([0, -1, 1.5])(
      "refuses installation id %s, which isn't a positive integer, before any call",
      async (installationId) => {
        const { github, calls } = fakeGitHub();

        const error = await rejection(github.installationRepoCount(installationId));

        expect(error).toBeInstanceOf(RangeError);
        expect(calls).toEqual([]);
      },
    );
  });

  const appSlug = (github: ReturnType<typeof createGitHub>) => github.appSlug();

  describe("appSlug", () => {
    it("sends the App's JWT to GET /app and answers the App's slug", async () => {
      const { github, calls } = fakeGitHub();

      expect(await appSlug(github)).toBe(SLUG);

      expect(calls.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([APP_URL]);
      const [call] = calls;
      expect(call!.init.method ?? "GET").toBe("GET");
      const jwt = /^Bearer (.+)$/.exec(header(call!, "Authorization") ?? "")?.[1];
      await jwtVerify(jwt!, createPublicKey(PRIVATE_KEY), {
        algorithms: ["RS256"],
        issuer: CLIENT_ID,
      });
    });

    it.each([
      ["no slug", { id: 1, name: "Warden reader" }],
      ["an empty slug", { id: 1, slug: "" }],
    ])("throws GitHubUnavailable when GET /app answers %s", async (_name, body) => {
      const { github } = fakeGitHub({ app: () => json(body) });

      const error = await rejection(appSlug(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS.app);
      expect((error as GitHubUnavailable).status).toBe(200);
    });
  });

  it("names the App's client id", () => {
    expect(fakeGitHub().github.clientId).toBe(CLIENT_ID);
  });

  it("sends GitHub's JSON media type and API version on every API call", async () => {
    const { github, calls } = fakeGitHub();

    await github.userInstallationRepos(CODE, VERIFIER, INSTALLATION_ID);
    await installationPermissions(github);
    await installationRepoCount(github);
    await appSlug(github);

    const apiCalls = calls.filter(({ url }) => url.origin === "https://api.github.com");
    expect(apiCalls.map(({ url }) => url.pathname)).toEqual([
      "/user/installations",
      `/user/installations/${INSTALLATION_ID}/repositories`,
      `/applications/${CLIENT_ID}/token`,
      `/app/installations/${INSTALLATION_ID}/access_tokens`,
      `/app/installations/${INSTALLATION_ID}/access_tokens`,
      "/installation/repositories",
      "/app",
    ]);
    for (const call of apiCalls) {
      expect(header(call, "Accept")).toBe("application/vnd.github+json");
      expect(header(call, "X-GitHub-Api-Version")).toBe("2026-03-10");
    }
  });

  /** Each step, failed by `answer`, through the call that reaches it. */
  const failures = (answer: Answer) =>
    [
      ["token", { token: answer }, userInstallationRepos],
      ["installations", { installations: answer }, userInstallationRepos],
      ["userRepos", { userRepos: answer }, userInstallationRepos],
      ["accessToken", { accessToken: answer }, installationPermissions],
      ["installationRepos", { installationRepos: answer }, installationRepoCount],
      ["app", { app: answer }, appSlug],
    ] as [
      keyof typeof STEPS,
      Parameters<typeof fakeGitHub>[0],
      (github: ReturnType<typeof createGitHub>) => Promise<unknown>,
    ][];

  it.each(failures(serverError))(
    "throws GitHubUnavailable carrying the step and 500 when the %s call answers 500",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect((error as GitHubUnavailable).status).toBe(500);
      expect(error.message).toContain(STEPS[step]);
      expect(error.message).toContain("500");
    },
  );

  it.each(failures(never))(
    "throws GitHubUnavailable when the %s call doesn't answer within timeoutMs",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers, 50);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect((error as GitHubUnavailable).status).toBeUndefined();
      expect(error.message).toMatch(/timed out after 50 ms/);
    },
  );

  it.each(failures(dropped))(
    "throws GitHubUnavailable when the %s call's connection drops",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
    },
  );

  it.each(failures(() => json({ unexpected: true })))(
    "throws GitHubUnavailable when the %s call's 2xx answer isn't the shape GitHub documents",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect((error as GitHubUnavailable).status).toBe(200);
    },
  );

  it.each(failures(bodyDrops))(
    "throws GitHubUnavailable naming the step, not a shape it doesn't document, when the %s call's body drops",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect((error as GitHubUnavailable).status).toBe(200);
      expect(error.message).toMatch(/terminated/);
      expect(error.message).not.toMatch(/shape/);
      expect(error.cause).toBeInstanceOf(TypeError);
    },
  );

  /** Each list, answered by `answer`, through the call that reads it. */
  const lists = (answer: Answer) => failures(answer).filter(([step]) => step in LIST_URLS);

  const LIST_URLS: Partial<Record<keyof typeof STEPS, string>> = {
    installations: INSTALLATIONS_URL,
    userRepos: USER_REPOS_URL,
  };

  /** A list page holding both lists' fields, so either list can read it. */
  const listPage = (total: number, entries: ReturnType<typeof repo>[]) =>
    json({ total_count: total, installations: entries, repositories: entries });

  it.each(
    lists((call) => {
      const n = Number(call.url.searchParams.get("page"));
      return listPage(
        1_000_000,
        items(100, (i) => repo((n - 1) * 100 + i)),
      );
    }),
  )(
    "throws GitHubUnavailable, after 100 pages, when the %s list doesn't end",
    async (step, answers, run) => {
      const { github, calls } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect(error.message).toMatch(/100 pages/);
      expect(callsTo(calls, LIST_URLS[step]!)).toHaveLength(100);
    },
  );

  it.each(lists(() => listPage(3, [repo(1), repo(2)])))(
    "throws GitHubUnavailable, not part of the list, when the %s list ends short of its total_count",
    async (step, answers, run) => {
      const { github } = fakeGitHub(answers);

      const error = await rejection(run(github));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect((error as GitHubUnavailable).step).toBe(STEPS[step]);
      expect(error.message).toMatch(/2 of 3/);
    },
  );

  describe("no error holds a secret", () => {
    /** Everything an error carries: its name, message, stack, every own field, and its causes', unredacted. */
    function everythingIn(value: unknown, seen = new Set<unknown>()): string {
      if (value === null || typeof value !== "object") return String(value);
      if (seen.has(value)) return "";
      seen.add(value);
      const names = new Set([
        ...Object.getOwnPropertyNames(value),
        ...(value instanceof Error ? ["name", "message", "stack", "cause"] : []),
      ]);
      return [...names]
        .map((name) => `${name}=${everythingIn((value as Record<string, unknown>)[name], seen)}`)
        .join("\n");
    }

    const answers: [string, Answer][] = [
      ["a 500", serverError],
      ["a 401 naming the credentials", () => json({ message: "Bad credentials" }, 401)],
      ["no answer", never],
      ["a dropped connection", dropped],
      ["a body that isn't JSON", () => new Response("<html>oops</html>", { status: 200 })],
      ["a body that drops mid-stream", bodyDrops],
    ];
    /** A case's name, its fake answers, the call it makes, and, where it matters, the step and status it fails at. */
    type Case = [
      string,
      Parameters<typeof fakeGitHub>[0],
      (github: ReturnType<typeof createGitHub>) => Promise<unknown>,
      { step: string; status: number }?,
    ];
    const cases = answers.flatMap(([name, answer]) =>
      failures(answer).map(([step, fakes, run]): Case => [`${name} at ${step}`, fakes, run]),
    );
    cases.push(
      [
        "a refused code",
        { token: () => json({ error: "bad_verification_code" }) },
        userInstallationRepos,
      ],
      [
        "refused client credentials",
        { token: () => json({ error: "incorrect_client_credentials" }) },
        userInstallationRepos,
      ],
      // Bug slice 3: GitHub's message, which repeats the request here, isn't carried into the error.
      [
        "a token answer repeating the request",
        { token: ({ init }) => json({ message: init.body as string }, 400) },
        userInstallationRepos,
        { step: STEPS.token, status: 400 },
      ],
      [
        "a list short of its total_count",
        { userRepos: () => json({ total_count: 3, repositories: [repo(1)] }) },
        userInstallationRepos,
      ],
      [
        "an installation GitHub won't give a token for",
        { accessToken: () => json({ message: "Not Found" }, 404) },
        installationPermissions,
      ],
    );

    it.each(cases)("with %s", async (_name, fakes, run, failsAt) => {
      const { github, calls } = fakeGitHub(fakes, 50);
      const error = await rejection(run(github));
      expect([GitHubRefusedCode, GitHubUnavailable, GitHubInstallationUnreachable]).toContain(
        error.constructor,
      );
      if (failsAt !== undefined) {
        expect(error).toBeInstanceOf(GitHubUnavailable);
        expect(error).toMatchObject(failsAt);
      }

      const jwts = calls
        .map((call) => /^Bearer (eyJ.+)$/.exec(header(call, "Authorization") ?? "")?.[1])
        .filter((jwt) => jwt !== undefined);
      const lines: string[] = [];
      createLogger((line) => lines.push(line)).error("Linking failed", { error });
      for (const serialised of [everythingIn(error), lines.join("")]) {
        for (const secret of [
          CODE,
          VERIFIER,
          CLIENT_SECRET,
          USER_TOKEN,
          INSTALLATION_TOKEN,
          ...jwts,
        ]) {
          expect(serialised).not.toContain(secret);
        }
      }
    });

    it.each([
      [
        "a revoke answer repeating the request",
        ({ init }: Call) => json({ message: init.body }, 422),
      ],
      ["a revoke that doesn't answer", never],
      ["a revoke whose connection drops", dropped],
    ] as [string, Answer][])("with %s, in the error handed on", async (_name, revoke) => {
      const { github } = fakeGitHub({ revoke }, 50);
      const failures: unknown[] = [];

      await github.userInstallationRepos(CODE, VERIFIER, INSTALLATION_ID, (error) => {
        failures.push(error);
      });

      expect(failures).toHaveLength(1);
      for (const secret of [CODE, VERIFIER, CLIENT_SECRET, USER_TOKEN]) {
        expect(everythingIn(failures[0])).not.toContain(secret);
      }
    });
  });
});
