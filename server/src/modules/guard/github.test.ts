// The GitHub client over a fake fetch (spec decision 11: GitHub is faked at its HTTP boundary). A person's code becomes
// a user token, which lists the installations they can reach and, in one of them, the repos they can read; the App's
// JWT becomes an installation token, which lists the installation's repos. Every page is read. Each failure throws
// GitHubRefusedCode or GitHubUnavailable, and none carries the code, the verifier, the client secret or a token.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { rejection } from "../../../test/helpers.ts";
import type { Fetch } from "../../http-call.ts";
import { createLogger } from "../../log.ts";
import { createGitHub, GitHubRefusedCode, GitHubUnavailable } from "./github.ts";

/** A GitHub App's key as GitHub downloads it: PKCS#1 PEM, `BEGIN RSA PRIVATE KEY`. */
const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

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
const REPOS_URL = "https://api.github.com/installation/repositories";
const USER_REPOS_URL = `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories`;

const STEPS = {
  token: "GitHub's user token exchange",
  installations: "GitHub's list of the user's installations",
  userRepos: `GitHub's list of the user's repositories in installation ${INSTALLATION_ID}`,
  accessToken: `GitHub's installation token for installation ${INSTALLATION_ID}`,
  repos: `GitHub's list of installation ${INSTALLATION_ID}'s repositories`,
};

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
    repos = (call) => {
      const all = items(2, repo);
      return json({ total_count: all.length, repositories: page(call, all) });
    },
  }: {
    token?: Answer;
    installations?: Answer;
    userRepos?: Answer;
    accessToken?: Answer;
    repos?: Answer;
  } = {},
  timeoutMs?: number,
) {
  const calls: Call[] = [];
  const routes: Record<string, Answer> = {
    [`POST ${TOKEN_URL}`]: token,
    [`GET ${INSTALLATIONS_URL}`]: installations,
    [`GET ${USER_REPOS_URL}`]: userRepos,
    [`POST ${ACCESS_TOKENS_URL}`]: accessToken,
    [`GET ${REPOS_URL}`]: repos,
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
        { ref: "https://github.com/acme/repo-1", githubId: 1001 },
      ]);

      const [exchange, list, repos] = calls;
      expect(calls).toHaveLength(3);
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

      expect(repos).toEqual(all.map((r) => ({ ref: r.html_url, githubId: r.id })));
      const pages = callsTo(calls, USER_REPOS_URL);
      expect(pages.map(({ url }) => url.searchParams.get("page"))).toEqual(["1", "2"]);
      for (const call of pages) expect(header(call, "Authorization")).toBe(`Bearer ${USER_TOKEN}`);
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
      expect(calls).toHaveLength(2);
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

  it("keeps the code, the verifier and the secret out of the error and its log line when the token answer repeats the request", async () => {
    const { github } = fakeGitHub({
      token: ({ init }) => json({ message: init.body as string }, 400),
    });

    const error = await rejection(userInstallationRepos(github));
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).error("Linking failed", { error });

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect((error as GitHubUnavailable).step).toBe(STEPS.token);
    expect((error as GitHubUnavailable).status).toBe(400);
    for (const serialised of [error.message, error.stack ?? "", lines.join("")]) {
      for (const secret of [CODE, VERIFIER, CLIENT_SECRET]) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  describe("installationRepos", () => {
    it("sends an App JWT that verifies against the key's public half, issued by the client id", async () => {
      const { github, calls } = fakeGitHub();
      const before = Math.floor(Date.now() / 1000);

      await github.installationRepos(INSTALLATION_ID);

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

    it("answers each repo's html_url as ref and id as githubId, with the installation token's permissions", async () => {
      const { github, calls } = fakeGitHub();

      expect(await github.installationRepos(INSTALLATION_ID)).toEqual({
        repos: [
          { ref: "https://github.com/acme/repo-1", githubId: 1001 },
          { ref: "https://github.com/acme/repo-2", githubId: 1002 },
        ],
        permissions: PERMISSIONS,
      });

      const [list] = callsTo(calls, REPOS_URL);
      expect(header(list!, "Authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    });

    it("reads every page when the installation lists more than 100 repos", async () => {
      const all = items(230, repo);
      const { github, calls } = fakeGitHub({
        repos: (call) => json({ total_count: all.length, repositories: page(call, all) }),
      });

      const { repos } = await github.installationRepos(INSTALLATION_ID);

      expect(repos.map(({ githubId }) => githubId)).toEqual(all.map(({ id }) => id));
      expect(callsTo(calls, REPOS_URL).map(({ url }) => url.searchParams.get("page"))).toEqual([
        "1",
        "2",
        "3",
      ]);
      expect(callsTo(calls, ACCESS_TOKENS_URL)).toHaveLength(1);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses installation id %s, which isn't a positive integer, before any call",
      async (installationId) => {
        const { github, calls } = fakeGitHub();

        const error = await rejection(github.installationRepos(installationId));

        expect(error).toBeInstanceOf(RangeError);
        expect(calls).toEqual([]);
      },
    );
  });

  it("sends GitHub's JSON media type and API version on every API call", async () => {
    const { github, calls } = fakeGitHub();

    await github.userInstallationRepos(CODE, VERIFIER, INSTALLATION_ID);
    await github.installationRepos(INSTALLATION_ID);

    const apiCalls = calls.filter(({ url }) => url.origin === "https://api.github.com");
    expect(apiCalls.map(({ url }) => url.pathname)).toEqual([
      "/user/installations",
      `/user/installations/${INSTALLATION_ID}/repositories`,
      `/app/installations/${INSTALLATION_ID}/access_tokens`,
      "/installation/repositories",
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
      [
        "accessToken",
        { accessToken: answer },
        (github) => github.installationRepos(INSTALLATION_ID),
      ],
      ["repos", { repos: answer }, (github) => github.installationRepos(INSTALLATION_ID)],
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
    repos: REPOS_URL,
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
    type Case = [
      string,
      Parameters<typeof fakeGitHub>[0],
      (github: ReturnType<typeof createGitHub>) => Promise<unknown>,
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
      [
        "a token answer repeating the request",
        { token: ({ init }) => json({ message: init.body as string }, 400) },
        userInstallationRepos,
      ],
      [
        "a list short of its total_count",
        { repos: () => json({ total_count: 3, repositories: [repo(1)] }) },
        (github) => github.installationRepos(INSTALLATION_ID),
      ],
    );

    it.each(cases)("with %s", async (_name, fakes, run) => {
      const { github, calls } = fakeGitHub(fakes, 50);
      const error = await rejection(run(github));
      expect([GitHubRefusedCode, GitHubUnavailable]).toContain(error.constructor);

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
  });
});
