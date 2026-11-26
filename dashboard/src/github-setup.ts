// Connecting GitHub (Guard spec, story 1): the calls the Setup pages make, GitHub's install and sign-in links, and
// the sign-in attempt the browser keeps between leaving for GitHub and coming back. GitHub's sign-in uses PKCE
// (RFC 7636): a fresh verifier per attempt, sent to GitHub only as its SHA-256 challenge, and to Warden with the code.
import {
  GitHubAppBody,
  LinkedInstallationBody,
  ReposBody,
  type Asset,
  type ListedRepoBody,
  type StartScanBody,
} from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";

/** 403 and 409 on a Team's call, read as every page reads them. */
type TeamRefusal = { kind: "no-team" } | { kind: "team-not-opened" };

export type GitHubAppResult =
  | { kind: "app"; app: GitHubAppBody }
  /** 503: this Warden has no GitHub app settings. */
  | { kind: "not-set-up" }
  /** 403: the person isn't an Admin (any more), or has no Team. */
  | { kind: "not-admin" }
  | { kind: "team-not-opened" }
  | Refused;

/** `GET /api/github/app`; a 502 (GitHub didn't answer) is not answering, as no answer is. */
export async function fetchGitHubApp(getToken: GetToken): Promise<GitHubAppResult> {
  const res = await callWarden(getToken, "/api/github/app");
  if (!(res instanceof Response)) return res;
  if (res.status === 503) return { kind: "not-set-up" };
  if (res.status === 403) return { kind: "not-admin" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const app = await parsed(res, GitHubAppBody);
  return app === undefined ? { kind: "not-answering" } : { kind: "app", app };
}

export type ReposResult = { kind: "repos"; repos: ListedRepoBody[] } | TeamRefusal | Refused;

/** `GET /api/repos`: the Team's Repo Assets, each with its last Guard Scan. */
export async function fetchRepos(getToken: GetToken): Promise<ReposResult> {
  const res = await callWarden(getToken, "/api/repos");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, ReposBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "repos", repos: body.repos };
}

export type LinkResult =
  | { kind: "linked"; installationId: number; repoCount: number }
  /** 400, 403, 409, 502 or 503: nothing was linked, in the server's words. */
  | { kind: "refused"; words: string }
  | Refused;

/** The refusals whose words the server gives for a person to read. */
const SAID = new Set([400, 403, 409, 502, 503]);

/** `POST /api/github/installations`: links the installation with GitHub's `code` and the attempt's verifier. */
export async function linkInstallation(
  getToken: GetToken,
  body: { installation_id: number; code: string; code_verifier: string },
): Promise<LinkResult> {
  const res = await callWarden(getToken, "/api/github/installations", { method: "POST", body });
  if (!(res instanceof Response)) return res;
  if (SAID.has(res.status)) {
    return { kind: "refused", words: (await serverError(res)) ?? "Nothing was linked." };
  }
  const linked = await parsed(res, LinkedInstallationBody);
  return linked === undefined
    ? { kind: "not-answering" }
    : {
        kind: "linked",
        installationId: linked.installation_id,
        repoCount: linked.repos.length,
      };
}

export type ScanStartResult =
  | { kind: "started" }
  /** 400, 502 or 503: no Scan started, in the server's words. A 502's Scan is stored failed, so the list changed. */
  | { kind: "refused"; words: string; listChanged: boolean }
  /** 403: the person isn't a Lead or an Admin (any more). */
  | { kind: "forbidden" }
  | { kind: "team-not-opened" }
  | Refused;

const NOT_STARTED = "Warden couldn't start the Scan.";

/** `POST /api/scans`: starts one Guard Scan of `assets`. Any other answer is not answering, as no answer is. */
export async function scanRepos(getToken: GetToken, assets: Asset[]): Promise<ScanStartResult> {
  const body: StartScanBody = { module: "guard", assets };
  const res = await callWarden(getToken, "/api/scans", { method: "POST", body });
  if (!(res instanceof Response)) return res;
  if (res.status === 202) return { kind: "started" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 409) return { kind: "team-not-opened" };
  if (res.status === 400 || res.status === 502 || res.status === 503) {
    const words = (await serverError(res)) ?? NOT_STARTED;
    return { kind: "refused", words, listChanged: res.status === 502 };
  }
  return { kind: "not-answering" };
}

/** The App's install page on GitHub; GitHub sends the Admin back to the App's Setup URL, `/setup/github`. */
export const installUrl = (slug: string) =>
  `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/**
 * GitHub's sign-in for the App, with PKCE (S256). No `redirect_uri`: GitHub uses the App's registered callback URL,
 * `/setup/github/callback`.
 */
export function signInUrl(clientId: string, state: string, codeChallenge: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** An installation id from GitHub's Setup URL: a positive whole number, or undefined for anything else. */
export function installationIdFrom(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** 32 random bytes, base64url: 43 characters, as RFC 7636 4.1 recommends for a verifier. A state is made the same way. */
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** A verifier's S256 challenge: its SHA-256, base64url (RFC 7636 4.2). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** One GitHub sign-in, kept in this tab between leaving for GitHub and coming back. */
export type SignInAttempt = { state: string; verifier: string; installationId: number };

/** Where the attempt is kept: `sessionStorage`, this tab's only, gone when it closes. */
export const ATTEMPT_KEY = "warden.githubSignIn";

/** Starts an attempt for `installationId`: keeps a fresh verifier and state, and answers GitHub's sign-in URL. */
export async function startSignIn(clientId: string, installationId: number): Promise<string> {
  const attempt: SignInAttempt = { state: randomToken(), verifier: randomToken(), installationId };
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  return signInUrl(clientId, attempt.state, await challengeOf(attempt.verifier));
}

/** The kept attempt, removed as it's read: GitHub's code works once, so an attempt is used once. */
export function takeAttempt(): SignInAttempt | undefined {
  let stored: string | null;
  try {
    stored = sessionStorage.getItem(ATTEMPT_KEY);
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    return undefined;
  }
  if (stored === null) return undefined;
  try {
    const value = JSON.parse(stored) as Partial<SignInAttempt>;
    if (
      typeof value.state === "string" &&
      typeof value.verifier === "string" &&
      typeof value.installationId === "number"
    ) {
      return { state: value.state, verifier: value.verifier, installationId: value.installationId };
    }
  } catch {
    // Not JSON: no attempt.
  }
  return undefined;
}

/**
 * Keeps a taken attempt again, for an attempt whose code never reached Warden (the session had ended), so the callback
 * can link with it once the person signs in again. Storage that refuses it leaves Connect again from Setup.
 */
export function putBackAttempt(attempt: SignInAttempt): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // Nothing kept: the callback says the sign-in didn't start here.
  }
}

/** "Too many tries: try again in 2 min", from the 429's Retry-After in seconds; "try again later" without one. */
export const tooManyTries = (retryAfter: number | null) =>
  `Too many tries: try again ${retryAfter === null ? "later" : `in ${Math.ceil(retryAfter / 60)} min`}`;
