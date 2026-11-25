// The GitHub client an Admin's link checks with (Guard spec, story 1). GitHub's Setup URL hands back an
// `installation_id` anyone can forge, so a link asks GitHub, as the person, which installations they can reach: their
// `code` (from GitHub's web application flow with PKCE) becomes a user access token, which lists them and, in the one
// linked, the repos the person can read. GitHub lists an installation to anyone who can read one of its repos, so only
// those repos are the person's to link. The App reads the installation's token permissions with its own installation
// token. Each token serves one link and is dropped: never stored, logged or returned, and no error this client throws
// carries one, the code, the verifier or the secret.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { CallFailed, callJson, type Answer, type Fetch } from "../../http-call.ts";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
/** The REST API version this client was written against (GitHub's "API versions"). */
const API_VERSION = "2026-03-10";
/** GitHub asks every request to name its client. */
const USER_AGENT = { "User-Agent": "Warden" };
/** GitHub's largest page for both lists. */
const PER_PAGE = 100;
/** The most pages a list is read for (10,000 items): a list that runs past it isn't read further. */
const MAX_PAGES = 100;
/** How long each call may take, its answer's body included. */
const CALL_TIMEOUT_MS = 10_000;

/** GitHub refused the person's code or its verifier: a bad, expired or reused one. Its `error` is GitHub's name. */
export class GitHubRefusedCode extends Error {
  override name = "GitHubRefusedCode";
  readonly error: string;
  constructor(error: string) {
    super(`GitHub refused the code (${error})`);
    this.error = error;
  }
}

/**
 * GitHub didn't give what a step needs: a non-2xx answer, one not in the shape GitHub documents, a timeout or a lost
 * connection. It names the step and the status (undefined when none came), never a token, the code or the secret.
 */
export class GitHubUnavailable extends Error {
  override name = "GitHubUnavailable";
  readonly step: string;
  readonly status: number | undefined;
  constructor(step: string, status: number | undefined, message: string, options?: ErrorOptions) {
    super(message, options);
    this.step = step;
    this.status = status;
  }
}

/** A repo as `RepoAssets.link` takes it: GitHub's `html_url` as its ref, GitHub's id as its githubId. */
export type GitHubRepo = { ref: string; githubId: number };

export interface GitHub {
  /**
   * The repos in the installation that the person whose `code` this is can read, through their user token; or
   * undefined when the installation isn't one they can reach. The code is exchanged once, so one call does both. An id
   * that isn't a positive integer is refused with a RangeError before any call.
   */
  userInstallationRepos(
    code: string,
    codeVerifier: string,
    installationId: number,
  ): Promise<GitHubRepo[] | undefined>;
  /**
   * The installation's repos, and its token's permissions as GitHub gives them (`{ contents: "read", … }`). An id that
   * isn't a positive integer is refused with a RangeError before any call.
   */
  installationRepos(
    installationId: number,
  ): Promise<{ repos: GitHubRepo[]; permissions: Record<string, string> }>;
}

/** GitHub's token answer refusing: it names an `error`, whatever the status (GitHub's troubleshooting page). */
const TokenRefusal = z.object({ error: z.string() });
const UserToken = z.object({ access_token: z.string().min(1) });
/** A page of a list: how many items GitHub counts in it, and this page's. */
type ListPage<T> = { total: number; items: T[] };
const Installations = z
  .object({
    total_count: z.number().int(),
    installations: z.array(z.object({ id: z.number().int() })),
  })
  .transform(({ total_count, installations }) => ({ total: total_count, items: installations }));
const InstallationToken = z.object({
  token: z.string().min(1),
  permissions: z.record(z.string(), z.string()).optional(),
});
const Repositories = z
  .object({
    total_count: z.number().int(),
    repositories: z.array(z.object({ id: z.number().int(), html_url: z.string() })),
  })
  .transform(({ total_count, repositories }) => ({ total: total_count, items: repositories }));

/**
 * The token answer's errors that are the person's: their code is bad, expired or reused (`bad_verification_code`),
 * or the verifier isn't the code's. GitHub's docs don't name the verifier's error, so `invalid_grant`, OAuth's name
 * for it (RFC 6749 5.2, RFC 7636 4.6), is taken as that. Any other error is GitHub's or Warden's own, such as wrong
 * client credentials or callback URL.
 */
const REFUSED_CODE = new Set(["bad_verification_code", "invalid_grant"]);

/** GitHub's own short reason from an API error's body (`{ message }`), if it gave one. */
function reason(body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "message" in body ? body.message : undefined;
  return typeof message === "string" && message !== "" ? ` (${message.slice(0, 200)})` : "";
}

/**
 * The answer's body as `schema` reads it, or the step's error naming what was missing. With `quiet`, a non-2xx answer's
 * own reason isn't repeated: for the token exchange, whose answer may repeat the request, secret and code included.
 */
function read<T>(
  schema: z.ZodType<T>,
  step: string,
  { status, ok, body }: Answer,
  { quiet = false } = {},
): T {
  if (!ok) {
    const why = quiet ? "" : reason(body);
    throw new GitHubUnavailable(step, status, `${step} answered HTTP ${status}${why}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubUnavailable(
      step,
      status,
      `${step} answered HTTP ${status} in a shape it doesn't document`,
    );
  }
  return parsed.data;
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The App's JWT (GitHub's "Generating a JSON Web Token"): RS256, issued by the client id 60 s in the past against
 * clock drift, expiring 10 minutes after that, so within the 10 minutes GitHub allows.
 */
function appJwt(clientId: string, key: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
}

const apiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  Authorization: `Bearer ${token}`,
  ...USER_AGENT,
});

const pageUrl = (path: string, page: number) => `${API}${path}?per_page=${PER_PAGE}&page=${page}`;

function checkInstallationId(id: number) {
  if (!(Number.isSafeInteger(id) && id > 0)) {
    throw new RangeError(`${id} isn't an installation id (a positive integer)`);
  }
}

const gitHubRepo = (repo: { id: number; html_url: string }): GitHubRepo => ({
  ref: repo.html_url,
  githubId: repo.id,
});

export function createGitHub({
  clientId,
  clientSecret,
  privateKey,
  fetch = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS,
}: {
  clientId: string;
  clientSecret: string;
  /** The App's private key as GitHub downloads it, a PKCS#1 PEM. */
  privateKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): GitHub {
  const key = createPrivateKey(privateKey);

  /** Calls `url` as the named step; a call or body read that throws is GitHubUnavailable, keeping fetch's cause. */
  async function call(step: string, url: string, init: RequestInit): Promise<Answer> {
    try {
      return await callJson(fetch, { step, url, init, timeoutMs });
    } catch (error) {
      if (!(error instanceof CallFailed)) throw error;
      throw new GitHubUnavailable(step, error.status, error.message, { cause: error.cause });
    }
  }

  /**
   * Every page of a list, 100 at a time, until a short page or as many as GitHub counts. A list that ends short of its
   * count, or runs past MAX_PAGES, throws rather than answer part of it.
   */
  async function everyPage<T>(
    step: string,
    path: string,
    token: string,
    list: z.ZodType<ListPage<T>>,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page += 1) {
      const answer = await call(step, pageUrl(path, page), { headers: apiHeaders(token) });
      const { total, items } = read(list, step, answer);
      all.push(...items);
      if (items.length < PER_PAGE || all.length >= total) {
        if (all.length < total) {
          throw new GitHubUnavailable(
            step,
            answer.status,
            `${step} ended at ${all.length} of ${total} items`,
          );
        }
        return all;
      }
      if (page === MAX_PAGES) {
        throw new GitHubUnavailable(step, answer.status, `${step} runs past ${MAX_PAGES} pages`);
      }
    }
  }

  async function userToken(code: string, codeVerifier: string): Promise<string> {
    const step = "GitHub's user token exchange";
    const answer = await call(step, TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...USER_AGENT },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
      }),
    });
    const refusal = TokenRefusal.safeParse(answer.body);
    if (refusal.success) {
      // GitHub's error names are short snake_case words; anything else isn't one, and isn't repeated.
      const error = /^[a-z_]{1,64}$/.test(refusal.data.error) ? refusal.data.error : "unnamed";
      if (REFUSED_CODE.has(error) && answer.status < 500) throw new GitHubRefusedCode(error);
      throw new GitHubUnavailable(
        step,
        answer.status,
        `${step} answered HTTP ${answer.status} refusing (${error})`,
      );
    }
    return read(UserToken, step, answer, { quiet: true }).access_token;
  }

  return {
    async userInstallationRepos(code, codeVerifier, installationId) {
      checkInstallationId(installationId);
      const token = await userToken(code, codeVerifier);
      const installations = await everyPage(
        "GitHub's list of the user's installations",
        "/user/installations",
        token,
        Installations,
      );
      if (!installations.some(({ id }) => id === installationId)) return undefined;
      const repositories = await everyPage(
        `GitHub's list of the user's repositories in installation ${installationId}`,
        `/user/installations/${installationId}/repositories`,
        token,
        Repositories,
      );
      return repositories.map(gitHubRepo);
    },

    async installationRepos(installationId) {
      checkInstallationId(installationId);
      const tokenStep = `GitHub's installation token for installation ${installationId}`;
      const granted = read(
        InstallationToken,
        tokenStep,
        await call(tokenStep, `${API}/app/installations/${installationId}/access_tokens`, {
          method: "POST",
          headers: apiHeaders(appJwt(clientId, key)),
        }),
      );
      const repositories = await everyPage(
        `GitHub's list of installation ${installationId}'s repositories`,
        "/installation/repositories",
        granted.token,
        Repositories,
      );
      return {
        repos: repositories.map(gitHubRepo),
        permissions: granted.permissions ?? {},
      };
    },
  };
}
