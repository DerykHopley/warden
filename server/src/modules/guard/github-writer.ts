// The GitHubWriter a Fix PR goes through (#224, story 6): the write app's calls, beside the read app's
// `github-reader.ts`. For one repo, the app gets an installation token scoped to that repo alone, by its GitHub id, and
// through it reads the repo's default branch and one file on it, makes a branch from the default branch's head, commits
// one file to that branch, and opens a PR from it into the default branch. It never writes to the default branch: no
// ref is moved or deleted, no contents write names it, and nothing is merged. Each token serves one request's calls
// and is then dropped; it and the app's JWT are never stored, logged, returned or put in an error. It needs the write
// app's client id and private key, never its client secret.
import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { CallFailed, callJson, type Answer, type Fetch } from "../../http-call.ts";
import { signAppJwt } from "./app-jwt.ts";
import { GitHubUnavailable, type GitHubRepo } from "./github.ts";

const API = "https://api.github.com";
/** The REST API version this writer was written against (GitHub's "API versions"), as `github.ts`'s. */
const API_VERSION = "2026-03-10";
/** How long each call may take, its answer's body included. */
const CALL_TIMEOUT_MS = 10_000;

/** A file the writer can't edit as text: not a file, too big for GitHub's contents API to send, or not UTF-8. */
export class FileUnreadable extends Error {
  override name = "FileUnreadable";
}

/** A PR as the writer answers it: GitHub's URL for it and its number. */
export type OpenedPull = { url: string; number: number };

/** The calls made through one repo-scoped token, on the repo it was scoped to. */
export interface RepoWriter {
  /** The repo's `owner/name` and default branch, as GitHub answered them by the repo's id. */
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The file at `path` on the default branch, with its blob sha; undefined when there's none. */
  readFile(path: string): Promise<{ text: string; sha: string } | undefined>;
  /** Whether the repo's PR `number` is open; false when GitHub has no such PR. */
  pullIsOpen(number: number): Promise<boolean>;
  /**
   * Makes branch `name` at the default branch's head: "created", or "exists" when the branch is already there, which
   * is left as it is. Never the default branch.
   */
  createBranch(name: string): Promise<"created" | "exists">;
  /** Commits `text` at `path` on `branch` (never the default branch), over the blob `sha` when the file exists. */
  writeFile(input: {
    branch: string;
    path: string;
    text: string;
    sha: string | undefined;
    message: string;
  }): Promise<void>;
  /** Opens a PR from `head` into the default branch. */
  openPull(input: { title: string; body: string; head: string }): Promise<OpenedPull>;
  /** The first open PR whose head is the repo's own `branch`, or undefined when none is. */
  openPullWithHead(branch: string): Promise<OpenedPull | undefined>;
}

/**
 * GitHub's answer to a token for one repo. A token: its permissions as GitHub's answer gives them (`{}` when it names
 * none), and `open` to start the repo's calls with it. None: GitHub's 404 (the app was uninstalled), 403 (suspended)
 * or 422 (the installation doesn't reach the repo).
 */
export type RepoToken =
  | { ok: true; permissions: Record<string, string>; open(): Promise<RepoWriter> }
  | { ok: false; status: 403 | 404 | 422 };

export interface GitHubWriter {
  /**
   * A token for the installation scoped to `repo` alone, by its GitHub id, with every permission the app was granted,
   * so the caller checks they're the write app's. An id that isn't a positive integer is refused with a RangeError
   * before any call. Throws GitHubUnavailable when GitHub answers otherwise.
   */
  repoToken(installationId: number, repo: GitHubRepo): Promise<RepoToken>;
}

const InstallationToken = z.object({
  token: z.string().min(1),
  permissions: z.record(z.string(), z.string()).optional(),
});
/** A repo's `full_name`: owner and name, each as `github-reader.ts`'s REPO_URL takes them. */
const FULL_NAME = /^([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;
const Repository = z.object({
  full_name: z.string().regex(FULL_NAME),
  default_branch: z.string().min(1),
});
/** A commit's sha: SHA-1's 40 hex digits, or SHA-256's 64. */
const Ref = z.object({
  object: z.object({ sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
});
const Contents = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  sha: z.string().min(1),
});
const PullUrl = z.url({ protocol: /^https$/, hostname: /^github\.com$/ });
const Pull = z.object({ html_url: PullUrl, number: z.number().int().positive() });
const PullState = z.object({ state: z.string() });

const apiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  Authorization: `Bearer ${token}`,
  "User-Agent": "Warden",
});

const jsonHeaders = (token: string) => ({
  ...apiHeaders(token),
  "Content-Type": "application/json",
});

/** A path of `/`-separated segments, each encoded, so a file or branch name can't step out of its place in a URL. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function checkInstallationId(id: number) {
  if (!(Number.isSafeInteger(id) && id > 0)) {
    throw new RangeError(`${id} isn't an installation id (a positive integer)`);
  }
}

/** The answer's body as `schema` reads it, or GitHubUnavailable naming the step; GitHub's own message isn't kept. */
function read<T>(schema: z.ZodType<T>, step: string, { status, ok, body }: Answer): T {
  if (!ok) throw new GitHubUnavailable(step, status, `${step} answered HTTP ${status}`);
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

const pull = ({ html_url, number }: z.infer<typeof Pull>): OpenedPull => ({
  url: html_url,
  number,
});

export function createGitHubWriter({
  clientId,
  privateKey,
  fetch = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS,
}: {
  clientId: string;
  /** The write app's private key as GitHub downloads it, a PKCS#1 PEM. */
  privateKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): GitHubWriter {
  const key = createPrivateKey(privateKey);

  /** One call as the named step; a call that throws becomes GitHubUnavailable, with fetch's own error as its cause. */
  async function call(step: string, url: string, init: RequestInit): Promise<Answer> {
    try {
      return await callJson(fetch, { step, url, init, timeoutMs });
    } catch (error) {
      if (!(error instanceof CallFailed)) throw error;
      throw new GitHubUnavailable(step, error.status, error.message, { cause: error.cause });
    }
  }

  /** The repo's calls through `token`, once its name, default branch and that branch's head are read. */
  async function open(token: string, repo: GitHubRepo): Promise<RepoWriter> {
    const { full_name: fullName, default_branch: defaultBranch } = read(
      Repository,
      "GitHub's repo read by id",
      await call("GitHub's repo read by id", `${API}/repositories/${repo.githubId}`, {
        headers: apiHeaders(token),
      }),
    );
    const [owner = ""] = fullName.split("/");
    const repoUrl = (path: string) => `${API}/repos/${encodePath(fullName)}/${path}`;
    const refUrl = (branch: string) => repoUrl(`git/ref/heads/${encodePath(branch)}`);
    const headStep = "GitHub's default branch head";
    const head = read(
      Ref,
      headStep,
      await call(headStep, refUrl(defaultBranch), { headers: apiHeaders(token) }),
    ).object.sha;

    /** Refuses `branch` when it's the default branch: Warden never writes there. */
    const notDefault = (branch: string) => {
      if (branch === defaultBranch) throw new Error("Warden never writes to the default branch");
    };

    return {
      fullName,
      defaultBranch,

      async readFile(path) {
        const step = "GitHub's file read at the default branch";
        const answer = await call(
          step,
          `${repoUrl(`contents/${encodePath(path)}`)}?ref=${encodeURIComponent(defaultBranch)}`,
          { headers: apiHeaders(token) },
        );
        if (answer.status === 404) return undefined;
        // A folder answers a list, which isn't the one file an edit writes.
        if (answer.ok && Array.isArray(answer.body)) {
          throw new FileUnreadable(`${path} is a folder on the default branch, not a file`);
        }
        const file = read(Contents, step, answer);
        // A file from 1 MB to 100 MB answers with no content (encoding "none"); a symlink or submodule isn't a file.
        if (file.type !== "file" || file.encoding !== "base64" || file.content === undefined) {
          throw new FileUnreadable(`${path} isn't a file Warden can read on the default branch`);
        }
        try {
          const bytes = Buffer.from(file.content, "base64");
          return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sha: file.sha };
        } catch {
          throw new FileUnreadable(`${path} isn't UTF-8 text`);
        }
      },

      async pullIsOpen(number) {
        const step = "GitHub's Fix PR read";
        const answer = await call(step, repoUrl(`pulls/${number}`), { headers: apiHeaders(token) });
        if (answer.status === 404) return false;
        return read(PullState, step, answer).state === "open";
      },

      async createBranch(name) {
        notDefault(name);
        const step = "GitHub's branch create";
        const answer = await call(step, repoUrl("git/refs"), {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify({ ref: `refs/heads/${name}`, sha: head }),
        });
        if (answer.status === 201) return "created";
        // GitHub answers 422 for a ref that's already there, and for other refusals; only a read of the branch tells
        // them apart.
        if (answer.status === 422) {
          const readStep = "GitHub's branch read";
          const there = await call(readStep, refUrl(name), { headers: apiHeaders(token) });
          if (there.status === 200) return "exists";
          throw new GitHubUnavailable(
            step,
            422,
            `${step} answered HTTP 422, and the branch isn't there`,
          );
        }
        throw new GitHubUnavailable(step, answer.status, `${step} answered HTTP ${answer.status}`);
      },

      async writeFile({ branch, path, text, sha, message }) {
        notDefault(branch);
        const step = "GitHub's commit to the Fix PR branch";
        const answer = await call(step, repoUrl(`contents/${encodePath(path)}`), {
          method: "PUT",
          headers: jsonHeaders(token),
          body: JSON.stringify({
            message,
            content: Buffer.from(text, "utf8").toString("base64"),
            branch,
            ...(sha === undefined ? {} : { sha }),
          }),
        });
        read(z.unknown(), step, answer);
      },

      async openPull({ title, body, head: branch }) {
        notDefault(branch);
        const step = "GitHub's PR create";
        return pull(
          read(
            Pull,
            step,
            await call(step, repoUrl("pulls"), {
              method: "POST",
              headers: jsonHeaders(token),
              body: JSON.stringify({ title, body, head: branch, base: defaultBranch }),
            }),
          ),
        );
      },

      async openPullWithHead(branch) {
        const step = "GitHub's open PRs from the Fix PR branch";
        const query = new URLSearchParams({
          head: `${owner}:${branch}`,
          state: "open",
          per_page: "1",
        });
        const [first] = read(
          z.array(Pull),
          step,
          await call(step, `${repoUrl("pulls")}?${query}`, { headers: apiHeaders(token) }),
        );
        return first && pull(first);
      },
    };
  }

  return {
    async repoToken(installationId, repo) {
      checkInstallationId(installationId);
      const step = `GitHub's installation token for installation ${installationId}`;
      // No `permissions` is asked for, so the token holds every permission the app was granted, and the caller's
      // check of them means something.
      const answer = await call(step, `${API}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: jsonHeaders(signAppJwt(clientId, key)),
        body: JSON.stringify({ repository_ids: [repo.githubId] }),
      });
      if (answer.status === 403 || answer.status === 404 || answer.status === 422) {
        return { ok: false, status: answer.status };
      }
      const { token, permissions = {} } = read(InstallationToken, step, answer);
      return { ok: true, permissions, open: () => open(token, repo) };
    },
  };
}
