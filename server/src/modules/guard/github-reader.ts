// The RepoReader a Guard Scan reads a repo through on GitHub (Guard spec, stories 3, 4 and 15). For each repo, the App
// gets an installation token scoped to that one repo with contents read only, downloads the repo's default-branch
// tarball with it, and yields its text files one at a time through the tar reader. Nothing touches disk. The token is
// dropped after the repo; it, the App's JWT and the download URL GitHub redirects to (which carries its own token) are
// never logged, stored or put in an error. It needs the App's client id and private key, never its client secret.
//
// It signs its own App JWT, the same RS256 shape as `github.ts`'s, so that file is left as it is here.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { CallFailed, callJson, type Answer, type Fetch } from "../../http-call.ts";
import type { Logger } from "../../log.ts";
import { GitHubInstallationUnreachable, GitHubUnavailable, type GitHubRepo } from "./github.ts";
import type { RepoReader } from "./repo-reader.ts";
import { newArchiveCounts, readTarball } from "./tarball.ts";

const API = "https://api.github.com";
/** The REST API version this reader was written against (GitHub's "API versions"), as `github.ts`'s. */
const API_VERSION = "2026-03-10";
/** How long the token call may take, its answer's body included. */
const CALL_TIMEOUT_MS = 10_000;
/** How long a repo's whole download may take, its redirect and body included. */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

/**
 * A repo's `html_url`: `https://github.com/<owner>/<repo>` and nothing more. GitHub's owner names are letters, digits
 * and hyphens; repo names add `.` and `_`.
 */
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

const InstallationToken = z.object({ token: z.string().min(1) });

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

/** Whether `error` is the call's signal firing: its timeout, or an abort. */
const timedOut = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

function checkInstallationId(id: number) {
  if (!(Number.isSafeInteger(id) && id > 0)) {
    throw new RangeError(`${id} isn't an installation id (a positive integer)`);
  }
}

/** The repo's owner and name from its ref, or GitHubUnavailable for a ref that isn't a GitHub repo's URL. */
function ownerAndName(ref: string): [string, string] {
  const match = REPO_URL.exec(ref);
  const [, owner, name] = match ?? [];
  if (owner === undefined || name === undefined || name === "." || name === "..") {
    const step = "the repo's ref";
    throw new GitHubUnavailable(step, undefined, `${step} isn't https://github.com/<owner>/<repo>`);
  }
  return [owner, name];
}

export function createGitHubReader({
  clientId,
  privateKey,
  logger,
  fetch = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS,
  archiveTimeoutMs = ARCHIVE_TIMEOUT_MS,
}: {
  clientId: string;
  /** The App's private key as GitHub downloads it, a PKCS#1 PEM. */
  privateKey: string;
  logger: Logger;
  fetch?: Fetch;
  timeoutMs?: number;
  archiveTimeoutMs?: number;
}): RepoReader {
  const key = createPrivateKey(privateKey);

  /** A token for this one repo, contents read only. Throws GitHubInstallationUnreachable on a 403 or 404. */
  async function repoToken(installationId: number, repo: GitHubRepo): Promise<string> {
    const step = `GitHub's installation token for installation ${installationId}`;
    let answer: Answer;
    try {
      answer = await callJson(fetch, {
        step,
        url: `${API}/app/installations/${installationId}/access_tokens`,
        init: {
          method: "POST",
          headers: { ...apiHeaders(appJwt(clientId, key)), "Content-Type": "application/json" },
          body: JSON.stringify({
            repository_ids: [repo.githubId],
            permissions: { contents: "read" },
          }),
        },
        timeoutMs,
      });
    } catch (error) {
      if (!(error instanceof CallFailed)) throw error;
      // fetch's own error, from before any token came, is kept as the cause.
      throw new GitHubUnavailable(step, error.status, error.message, { cause: error.cause });
    }
    if (answer.status === 403 || answer.status === 404) {
      throw new GitHubInstallationUnreachable(installationId, answer.status);
    }
    // The answer's body isn't repeated: a 2xx one holds the token.
    if (!answer.ok) {
      throw new GitHubUnavailable(step, answer.status, `${step} answered HTTP ${answer.status}`);
    }
    const parsed = InstallationToken.safeParse(answer.body);
    if (!parsed.success) {
      throw new GitHubUnavailable(
        step,
        answer.status,
        `${step} answered HTTP ${answer.status} in a shape it doesn't document`,
      );
    }
    return parsed.data.token;
  }

  return {
    async *readRepo(installationId, repo) {
      checkInstallationId(installationId);
      const [owner, name] = ownerAndName(repo.ref);
      const token = await repoToken(installationId, repo);

      const step = `GitHub's tarball of ${repo.ref}`;
      // GitHub answers with a redirect to a short-lived download URL, which fetch follows; one signal covers the
      // redirect and the body. fetch's errors aren't kept: one on the redirect's leg may name that URL.
      let response: Response;
      try {
        response = await fetch(
          `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tarball`,
          { headers: apiHeaders(token), signal: AbortSignal.timeout(archiveTimeoutMs) },
        );
      } catch (error) {
        const why = timedOut(error) ? `timed out after ${archiveTimeoutMs} ms` : "failed";
        throw new GitHubUnavailable(step, undefined, `${step} ${why}`);
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        // An empty repo's tarball may answer 404 (GitHub documents it for the zip archive).
        throw new GitHubUnavailable(
          step,
          response.status,
          `${step} answered HTTP ${response.status}`,
        );
      }

      const counts = newArchiveCounts();
      yield* readTarball(response.body, { step, counts });
      logger.info("guard scan: archive read", { repo: repo.ref, ...counts });
    },
  };
}
