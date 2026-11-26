// Connecting GitHub (Guard spec, story 1) and granting write access (#224, story 5): the calls the Setup pages make,
// GitHub's install and sign-in links for each app, and the sign-in attempt the browser keeps between leaving for GitHub
// and coming back. GitHub's sign-in uses PKCE
// (RFC 7636): a fresh verifier per attempt, sent to GitHub only as its SHA-256 challenge, and to Warden with the code.
import {
  GitHubAppBody,
  LinkedInstallationBody,
  ReposBody,
  ScanBody,
  WriteGrantBody,
  WriteGrantsBody,
  type Asset,
  type LinkInstallationBody,
  type ListedRepoBody,
  type StartScanBody,
} from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";

/** 403 and 409 on a Team's call, read as every page reads them. */
type TeamRefusal = { kind: "no-team" } | { kind: "team-not-opened" };

/** Where the read app's sign-in attempt is kept: `sessionStorage`, this tab's only, gone when it closes. */
export const ATTEMPT_KEY = "warden.githubSignIn";
/** Where the write app's attempt is kept, apart from the read app's, so neither's sign-in is taken as the other's. */
export const WRITE_ATTEMPT_KEY = "warden.githubWriteSignIn";

/**
 * One of Warden's two GitHub apps, as the dashboard reaches it: the read app links Repo Assets (story 1), and the write
 * app grants the write access Fix PRs go through (#224, story 5). Each has its own settings route, callback page,
 * kept attempt, and the h1 its Connect and callback pages share.
 */
export type WardenApp = {
  settingsPath: string;
  callbackPath: string;
  attemptKey: string;
  heading: string;
};

export const READ_APP: WardenApp = {
  settingsPath: "/api/github/app",
  callbackPath: "/setup/github/callback",
  attemptKey: ATTEMPT_KEY,
  heading: "Connect GitHub",
};

export const WRITE_APP: WardenApp = {
  settingsPath: "/api/github/write-app",
  callbackPath: "/setup/github/write/callback",
  attemptKey: WRITE_ATTEMPT_KEY,
  heading: "Grant write access",
};

/** The id of Setup's Repos heading, where Scan now is: Findings' "Scan now" link lands on it (#342). */
export const REPOS_ANCHOR = "setup-repos";

export type GitHubAppResult =
  | { kind: "app"; app: GitHubAppBody }
  /** 503: this Warden has no settings for the app. */
  | { kind: "not-set-up" }
  /** 403: the person isn't an Admin (any more), or has no Team. */
  | { kind: "not-admin" }
  | { kind: "team-not-opened" }
  | Refused;

/**
 * `GET /api/github/app`, or the write app's `GET /api/github/write-app`; a 502 (GitHub didn't answer) is not
 * answering, as no answer is.
 */
export async function fetchGitHubApp(getToken: GetToken, app: WardenApp): Promise<GitHubAppResult> {
  const res = await callWarden(getToken, app.settingsPath);
  if (!(res instanceof Response)) return res;
  if (res.status === 503) return { kind: "not-set-up" };
  if (res.status === 403) return { kind: "not-admin" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, GitHubAppBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "app", app: body };
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
  body: LinkInstallationBody,
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

export type WriteGrantsResult =
  { kind: "grants"; grants: WriteGrantBody[] } | TeamRefusal | Refused;

/** `GET /api/github/write-grant`: the Team's write grants, read by anyone in it (#224, story 5). */
export async function fetchWriteGrants(getToken: GetToken): Promise<WriteGrantsResult> {
  const res = await callWarden(getToken, "/api/github/write-grant");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, WriteGrantsBody);
  return body === undefined
    ? { kind: "not-answering" }
    : { kind: "grants", grants: body.installations };
}

export type GrantResult =
  /** 201 for a new grant, 200 for one the Team already held. */
  | { kind: "granted"; installationId: number }
  /** 400, 403, 409, 502 or 503: nothing was granted, in the server's words. */
  | { kind: "refused"; words: string }
  | Refused;

/** `POST /api/github/write-installations`: grants write access through the installation, as `linkInstallation` links. */
export async function grantWriteAccess(
  getToken: GetToken,
  body: LinkInstallationBody,
): Promise<GrantResult> {
  const res = await callWarden(getToken, "/api/github/write-installations", {
    method: "POST",
    body,
  });
  if (!(res instanceof Response)) return res;
  if (SAID.has(res.status)) {
    return { kind: "refused", words: (await serverError(res)) ?? "Nothing was granted." };
  }
  const grant = await parsed(res, WriteGrantBody);
  return grant === undefined
    ? { kind: "not-answering" }
    : { kind: "granted", installationId: grant.installation_id };
}

export type ScanStartResult =
  /** 202: the Scan queued, as the server stored it. */
  | { kind: "started"; scan: ScanBody }
  /**
   * 400, 503 or another 5xx: no Scan started, in the server's words. `listChanged` when the list may have: a 400 can
   * answer a list gone stale, and a 502's or an unexpected 5xx's Scan may be stored failed. A 503 stores nothing.
   */
  | { kind: "refused"; words: string; listChanged: boolean }
  /** 403: the person isn't a Lead or an Admin (any more). */
  | { kind: "forbidden" }
  | { kind: "team-not-opened" }
  | Refused;

const NOT_STARTED = "Warden couldn't start the Scan.";

/**
 * `POST /api/scans`: starts one Guard Scan of `assets`. Any other answer below 500, or a 202 whose Scan doesn't parse,
 * is not answering, as no answer is.
 */
export async function scanRepos(getToken: GetToken, assets: Asset[]): Promise<ScanStartResult> {
  const body: StartScanBody = { module: "guard", assets };
  const res = await callWarden(getToken, "/api/scans", { method: "POST", body });
  if (!(res instanceof Response)) return res;
  if (res.status === 202) {
    const scan = await parsed(res, ScanBody);
    return scan === undefined ? { kind: "not-answering" } : { kind: "started", scan };
  }
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 409) return { kind: "team-not-opened" };
  if (res.status === 400 || res.status >= 500) {
    const words = (await serverError(res)) ?? NOT_STARTED;
    return { kind: "refused", words, listChanged: res.status !== 503 };
  }
  return { kind: "not-answering" };
}

/**
 * An app's install page on GitHub; GitHub sends the Admin back to the app's Setup URL, `/setup/github` for the read
 * app and `/setup/github/write` for the write app.
 */
export const installUrl = (slug: string) =>
  `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/**
 * GitHub's sign-in for an app, with PKCE (S256). Its `redirect_uri` is this page's own origin plus the app's callback
 * path, so a sign-in started on an owner preview comes back to the preview, where this tab's attempt is kept (#275).
 * GitHub accepts it only when it's one of the app's registered callback URLs; otherwise it refuses with
 * `redirect_uri_mismatch`. GitHub's docs don't say where a GitHub App's refusal lands: on GitHub, or on one of the
 * app's registered callback pages (the live dashboard's or a preview's), which shows the code.
 */
export function signInUrl(
  clientId: string,
  state: string,
  codeChallenge: string,
  app: WardenApp,
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "redirect_uri",
    new URL(app.callbackPath, window.location.origin).toString(),
  );
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

/**
 * Starts an attempt for `installationId` with `app`: keeps a fresh verifier and state under the app's key, and answers
 * GitHub's sign-in URL.
 */
export async function startSignIn(
  clientId: string,
  installationId: number,
  app: WardenApp,
): Promise<string> {
  const attempt: SignInAttempt = { state: randomToken(), verifier: randomToken(), installationId };
  sessionStorage.setItem(app.attemptKey, JSON.stringify(attempt));
  return signInUrl(clientId, attempt.state, await challengeOf(attempt.verifier), app);
}

/**
 * The app's kept attempt, removed as it's read: GitHub's code works once, so an attempt is used once. The other app's
 * attempt is never read.
 */
export function takeAttempt(app: WardenApp): SignInAttempt | undefined {
  let stored: string | null;
  try {
    stored = sessionStorage.getItem(app.attemptKey);
    sessionStorage.removeItem(app.attemptKey);
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
export function putBackAttempt(attempt: SignInAttempt, app: WardenApp): void {
  try {
    sessionStorage.setItem(app.attemptKey, JSON.stringify(attempt));
  } catch {
    // Nothing kept: the callback says the sign-in didn't start here.
  }
}

/** "Too many tries: try again in 2 min", from the 429's Retry-After in seconds; "try again later" without one. */
export const tooManyTries = (retryAfter: number | null) =>
  `Too many tries: try again ${retryAfter === null ? "later" : `in ${Math.ceil(retryAfter / 60)} min`}`;
