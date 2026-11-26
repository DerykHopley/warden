// The RepoReader a Guard Scan reads a repo through on GitHub (Guard spec, stories 3, 4 and 15). For each repo, the App
// gets an installation token scoped to that one repo with contents read only, downloads the repo's default-branch
// tarball with it, and yields its text files one at a time through the tar reader; a repo with no commits, whose
// tarball answers 404 and whose commits answer 409, yields none. Nothing touches disk. The token is
// dropped after the repo; it, the App's JWT and the download URL GitHub redirects to (which carries its own token) are
// never logged, stored or put in an error. It needs the App's client id and private key, never its client secret.
import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { CallFailed, callJson, timedOut, type Answer, type Fetch } from "../../http-call.ts";
import type { Logger } from "../../log.ts";
import { signAppJwt } from "./app-jwt.ts";
import { GitHubInstallationUnreachable, GitHubUnavailable, type GitHubRepo } from "./github.ts";
import type { RepoReader } from "./repo-reader.ts";
import { newArchiveCounts, readTarball } from "./tarball.ts";

const API = "https://api.github.com";
/** The REST API version this reader was written against (GitHub's "API versions"), as `github.ts`'s. */
const API_VERSION = "2026-03-10";
/** How long the token call may take, its answer's body included. */
const CALL_TIMEOUT_MS = 10_000;
/**
 * How long GitHub may keep a repo's download waiting: for its answer, the redirect included, or for any one chunk of
 * its body. The time the Scan spends on the files between chunks doesn't count, so a big repo isn't cut off.
 */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

/**
 * A repo's `html_url`: `https://github.com/<owner>/<repo>` and nothing more. GitHub's owner names are letters, digits
 * and hyphens, and an Enterprise Managed User's add an `_` before the enterprise's shortcode; repo names add `.`. The
 * lengths are looser than GitHub's: the check only keeps the tarball call's path to one repo.
 */
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;

const InstallationToken = z.object({ token: z.string().min(1) });

const apiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  Authorization: `Bearer ${token}`,
  "User-Agent": "Warden",
});

/** The REST API's URL for `path` under one repo, its owner and name encoded. */
const repoApiUrl = (owner: string, name: string, path: string) =>
  `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${path}`;

/**
 * `waiting`, settled as it settles, with `download` aborted by a TimeoutError if it takes `ms`. fetch then rejects, or
 * errors its answer's body, with that error.
 */
async function awaitWithin<T>(waiting: Promise<T>, download: AbortController, ms: number) {
  const timer = setTimeout(
    () => download.abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError")),
    ms,
  );
  try {
    return await waiting;
  } finally {
    clearTimeout(timer);
  }
}

/** The body's chunks, GitHub given `ms` to send each one. */
async function* chunksWithin(
  body: ReadableStream<Uint8Array>,
  download: AbortController,
  ms: number,
): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    const next = await awaitWithin(iterator.next(), download, ms);
    if (next.done) return;
    yield next.value;
  }
}

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

  /**
   * A token for this one repo, contents read only. Throws GitHubInstallationUnreachable on a 403 or 404, and on a 422,
   * GitHub's answer for a repo the installation no longer reaches.
   */
  async function repoToken(installationId: number, repo: GitHubRepo): Promise<string> {
    const step = `GitHub's installation token for installation ${installationId}`;
    let answer: Answer;
    try {
      answer = await callJson(fetch, {
        step,
        url: `${API}/app/installations/${installationId}/access_tokens`,
        init: {
          method: "POST",
          headers: { ...apiHeaders(signAppJwt(clientId, key)), "Content-Type": "application/json" },
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
    if (answer.status === 403 || answer.status === 404 || answer.status === 422) {
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

  /**
   * Whether the repo has no commits, asked after its tarball answered 404: GitHub answers its commits 409 then, with a
   * JSON body. Any other answer, or none, is "not known to be empty", so the tarball's 404 stands.
   */
  async function hasNoCommits(owner: string, name: string, token: string): Promise<boolean> {
    try {
      const answer = await callJson(fetch, {
        step: "GitHub's commits check",
        url: repoApiUrl(owner, name, "commits?per_page=1"),
        init: { headers: apiHeaders(token) },
        timeoutMs,
      });
      return answer.status === 409 && answer.body !== undefined;
    } catch (error) {
      if (error instanceof CallFailed) return false;
      throw error;
    }
  }

  return {
    async *readRepo(installationId, repo) {
      checkInstallationId(installationId);
      const [owner, name] = ownerAndName(repo.ref);
      const token = await repoToken(installationId, repo);

      const step = `GitHub's tarball of ${repo.ref}`;
      // GitHub answers with a redirect to a short-lived download URL, which fetch follows; one signal covers the
      // redirect and the body. It fires when GitHub keeps the download waiting too long, and once the read stops for
      // any reason (the archive's end, a limit, a bad archive, the Scan stopping), so the connection never lingers.
      // fetch's errors aren't kept: one on the redirect's leg may name that URL.
      const download = new AbortController();
      try {
        let response: Response;
        try {
          response = await awaitWithin(
            fetch(repoApiUrl(owner, name, "tarball"), {
              headers: apiHeaders(token),
              signal: download.signal,
            }),
            download,
            archiveTimeoutMs,
          );
        } catch (error) {
          const why = timedOut(error) ? `timed out after ${archiveTimeoutMs} ms` : "failed";
          throw new GitHubUnavailable(step, undefined, `${step} ${why}`);
        }
        // A repo with no commits has no archive, and its tarball answers 404 (GitHub documents it for the zip archive),
        // as a repo gone or out of reach does; only an empty one's commits answer 409. It's read as no files.
        if (response.status === 404 && (await hasNoCommits(owner, name, token))) {
          logger.info("guard scan: repo empty", { repo: repo.ref });
          return;
        }
        if (!response.ok || response.body === null) {
          throw new GitHubUnavailable(
            step,
            response.status,
            `${step} answered HTTP ${response.status}`,
          );
        }

        const counts = newArchiveCounts();
        yield* readTarball(chunksWithin(response.body, download, archiveTimeoutMs), {
          step,
          counts,
        });
        logger.info("guard scan: archive read", { repo: repo.ref, ...counts });
      } finally {
        download.abort();
      }
    },
  };
}
