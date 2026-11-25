// The GitHub client an Admin's link checks with (Guard spec, story 1). GitHub's Setup URL hands back an
// `installation_id` anyone can forge, so a link asks GitHub, as the person, which installations they can reach: their
// `code` (from GitHub's web application flow with PKCE) becomes a user access token, which lists them. The App then
// reads an installation's repos with its own installation token. Each token serves one read and is dropped: never
// stored, logged or returned, and no error this client throws carries one, the code, the verifier or the secret.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { Fetch } from "../../cloud-run-scan-job-starter.ts";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
/** The REST API version this client was written against (GitHub's "API versions"). */
const API_VERSION = "2026-03-10";
/** GitHub's largest page for both lists. */
const PER_PAGE = 100;
/** How long each call may take, its answer's body included. */
const CALL_TIMEOUT_MS = 10_000;

/** GitHub refused the person's code (or its verifier): a bad, expired or reused one. Its `error` is GitHub's name. */
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
  /** The installations the person whose `code` this is can reach, by id. */
  userInstallationIds(code: string, codeVerifier: string): Promise<number[]>;
  /** The installation's repos, and its token's permissions as GitHub gives them (`{ contents: "read", … }`). */
  installationRepos(
    installationId: number,
  ): Promise<{ repos: GitHubRepo[]; permissions: Record<string, string> }>;
}

/** GitHub's token answer refusing: it names an `error`, whatever the status (GitHub's troubleshooting page). */
const TokenRefusal = z.object({ error: z.string() });
const UserToken = z.object({ access_token: z.string().min(1) });
const Installations = z.object({ installations: z.array(z.object({ id: z.number().int() })) });
const InstallationToken = z.object({
  token: z.string().min(1),
  permissions: z.record(z.string(), z.string()).optional(),
});
const Repositories = z.object({
  repositories: z.array(z.object({ id: z.number().int(), html_url: z.string() })),
});

/** The token answer's error that is Warden's own: its client id or secret is wrong, not the person's code. */
const WARDENS_CREDENTIALS = "incorrect_client_credentials";

/** Whether `error` is the call's signal firing: its timeout, or an abort. */
const timedOut = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** The step's error for a call, or a body read, that threw. */
function unanswered(step: string, status: number | undefined, error: unknown, timeoutMs: number) {
  const message = timedOut(error)
    ? `${step} timed out after ${timeoutMs} ms`
    : `${step} failed: ${error instanceof Error ? error.message : String(error)}`;
  return new GitHubUnavailable(step, status, message, { cause: error });
}

/** GitHub's own short reason from an API error's body (`{ message }`), if it gave one. */
function reason(body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "message" in body ? body.message : undefined;
  return typeof message === "string" && message !== "" ? ` (${message.slice(0, 200)})` : "";
}

/** An answer: its status, whether it was 2xx, and its JSON body (undefined when it isn't JSON). */
type Answer = { status: number; ok: boolean; body: unknown };

/** Calls `url` as the named step, its body read within the same timeout. Only a call that never answered throws. */
async function call(
  fetch: Fetch,
  step: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Answer> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    // fetch's own error: it names the failure, never the request's headers or body.
    throw unanswered(step, undefined, error, timeoutMs);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A body that never arrived is a timeout; one that isn't JSON is checked against its shape, below.
    if (timedOut(error)) throw unanswered(step, response.status, error, timeoutMs);
  }
  return { status: response.status, ok: response.ok, body };
}

/** The answer's body as `schema` reads it, or the step's error naming what was missing. */
function read<T>(schema: z.ZodType<T>, step: string, { status, ok, body }: Answer): T {
  if (!ok)
    throw new GitHubUnavailable(step, status, `${step} answered HTTP ${status}${reason(body)}`);
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

/** Every page of a list, 100 at a time: a page shorter than that is the last. */
async function everyPage<T>(readPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const items = await readPage(page);
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
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
  "User-Agent": "Warden",
});

const pageUrl = (path: string, page: number) => `${API}${path}?per_page=${PER_PAGE}&page=${page}`;

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

  async function userToken(code: string, codeVerifier: string): Promise<string> {
    const step = "GitHub's user token exchange";
    const answer = await call(
      fetch,
      step,
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Warden",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
        }),
      },
      timeoutMs,
    );
    const refusal = TokenRefusal.safeParse(answer.body);
    if (refusal.success) {
      // GitHub's error names are short snake_case words; anything else isn't one, and isn't repeated.
      const error = /^[a-z_]{1,64}$/.test(refusal.data.error) ? refusal.data.error : "unnamed";
      if (error === WARDENS_CREDENTIALS) {
        throw new GitHubUnavailable(
          step,
          answer.status,
          `${step} refused Warden's client credentials (${error})`,
        );
      }
      throw new GitHubRefusedCode(error);
    }
    return read(UserToken, step, answer).access_token;
  }

  return {
    async userInstallationIds(code, codeVerifier) {
      const token = await userToken(code, codeVerifier);
      const step = "GitHub's list of the user's installations";
      const installations = await everyPage(async (page) => {
        const answer = await call(
          fetch,
          step,
          pageUrl("/user/installations", page),
          { headers: apiHeaders(token) },
          timeoutMs,
        );
        return read(Installations, step, answer).installations;
      });
      return installations.map(({ id }) => id);
    },

    async installationRepos(installationId) {
      const tokenStep = `GitHub's installation token for installation ${installationId}`;
      const granted = read(
        InstallationToken,
        tokenStep,
        await call(
          fetch,
          tokenStep,
          `${API}/app/installations/${installationId}/access_tokens`,
          { method: "POST", headers: apiHeaders(appJwt(clientId, key)) },
          timeoutMs,
        ),
      );
      const step = `GitHub's list of installation ${installationId}'s repositories`;
      const repositories = await everyPage(async (page) => {
        const answer = await call(
          fetch,
          step,
          pageUrl("/installation/repositories", page),
          { headers: apiHeaders(granted.token) },
          timeoutMs,
        );
        return read(Repositories, step, answer).repositories;
      });
      return {
        repos: repositories.map((repo) => ({ ref: repo.html_url, githubId: repo.id })),
        permissions: granted.permissions ?? {},
      };
    },
  };
}
