// GitHub as the browser tests' server sees it (#224, story 6). This module only defines the fake and runs nothing:
// `fake-github-preload.ts`, loaded with `--import` into the server and each Scan Job it starts (the global setup's
// NODE_OPTIONS), installs it there, in place of `globalThis.fetch` for https://api.github.com and https://github.com,
// passing every other address on. The browser tests' own processes never install it: they only ever call the server,
// and fix-pr.spec.ts calls the fake's handler directly.
//
// It answers the write app's calls on the one repo it knows, `DAHLIA_REPO` (`github-writer.ts`), and the app's own
// read (`GET /app`, which a Setup page's install link is built from); anything else on those hosts answers 404. It
// keeps the branches made (`main` from the start) and the PRs opened, all of them open and each the app's bot's with
// its one commit, for as long as the process runs: nothing it answers closes or merges a PR. Each call is appended to
// the file `E2E_FAKE_GITHUB_LOG` names, as one JSON line of its method, path (with its query) and JSON body, never its
// headers, so never its Authorization.
// With that variable unset, as in a Scan Job (the server hands it only some of its variables), the fake still answers
// a read (GET), unlogged, and refuses every other call with a rejected fetch naming it, so a write no test could see
// fails loudly instead. Only `node:` modules are imported: Node loads this file as it is, types stripped.
import { appendFileSync } from "node:fs";

/** One call the fake answered, as it logs it. `body` is the request's JSON body, or null when it had none. */
export type Logged = { method: string; path: string; body: unknown };

/** The one repo the fake knows, by its URL and GitHub id: Dahlia's Repo Asset (`session.ts`). */
export const DAHLIA_REPO = { ref: "https://github.com/dahlia/agent-tools", githubId: 9301 };

/** `DAHLIA_REPO`'s full name on GitHub, `<owner>/<name>`, as its API paths hold it. */
export const DAHLIA_REPO_FULL_NAME = new URL(DAHLIA_REPO.ref).pathname.slice(1);

/** The permissions the fake's installation tokens hold: exactly the write app's (`write-grant-routes.ts`). */
const WRITE_APP_PERMISSIONS = { contents: "write", pull_requests: "write", metadata: "read" };

/** The commit `main` points at from the start. */
const MAIN_HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The commit each file written on a branch makes its head. */
const NEW_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

/** The app's slug, as `GET /app` answers it, and the bot login each PR it opens and its one commit carry. */
const APP_SLUG = "warden-writer";
const APP_BOT = `${APP_SLUG}[bot]`;

const GITHUB_HOSTS = new Set(["api.github.com", "github.com"]);

type Pull = { number: number; head: string; base: string; state: "open" | "closed" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const notFound = () => json(404, { message: "Not Found" });

/**
 * A fake of GitHub, as a handler from a request to its answer, with its own branches and PRs. Each request is logged
 * to the file `log` names before it's answered; with no `log`, only a GET is answered, and anything else rejects.
 */
export function createFakeGitHub({ log }: { log?: string | undefined } = {}) {
  const fullName = DAHLIA_REPO_FULL_NAME;
  const owner = fullName.split("/")[0];
  const branches = new Map([["main", MAIN_HEAD]]);
  const pulls: Pull[] = [];

  const pullBody = (pull: Pull) => ({
    number: pull.number,
    state: pull.state,
    html_url: `${DAHLIA_REPO.ref}/pull/${pull.number}`,
    user: { login: APP_BOT, type: "Bot" },
    head: { ref: pull.head },
    base: { ref: pull.base },
  });

  /** The answer to a call on the repo's own paths, `rest` being what follows `/repos/<owner>/<name>/`. */
  function onRepo(method: string, rest: string[], url: URL, body: Record<string, unknown>) {
    const [first, second, third, ...more] = rest;
    if (method === "GET" && first === "git" && second === "ref" && third === "heads") {
      const sha = branches.get(more.join("/"));
      return sha === undefined
        ? notFound()
        : json(200, { ref: `refs/heads/${more.join("/")}`, object: { sha, type: "commit" } });
    }
    if (method === "POST" && first === "git" && second === "refs" && rest.length === 2) {
      const ref = typeof body.ref === "string" ? body.ref : "";
      const name = ref.replace(/^refs\/heads\//, "");
      if (!ref.startsWith("refs/heads/") || branches.has(name)) {
        return json(422, { message: "Reference already exists" });
      }
      branches.set(name, String(body.sha));
      return json(201, { ref, object: { sha: body.sha, type: "commit" } });
    }
    // No file is on `main`: each read of one is GitHub's 404.
    if (method === "GET" && first === "contents") return notFound();
    if (method === "PUT" && first === "contents") {
      const branch = typeof body.branch === "string" ? body.branch : "";
      if (!branches.has(branch) || branch === "main") return notFound();
      branches.set(branch, NEW_COMMIT);
      return json(201, { content: { path: rest.slice(1).join("/") }, commit: { sha: NEW_COMMIT } });
    }
    if (method === "POST" && first === "pulls" && rest.length === 1) {
      const head = typeof body.head === "string" ? body.head : "";
      if (!branches.has(head)) return json(422, { message: "Validation Failed" });
      const pull: Pull = {
        number: pulls.length + 1,
        head,
        base: typeof body.base === "string" ? body.base : "main",
        state: "open",
      };
      pulls.push(pull);
      return json(201, pullBody(pull));
    }
    if (method === "GET" && first === "pulls" && rest.length === 1) {
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      const state = url.searchParams.get("state") ?? "open";
      return json(
        200,
        pulls
          .filter(
            (pull) =>
              (head === null || `${owner}:${pull.head}` === head) &&
              (base === null || pull.base === base) &&
              (state === "all" || pull.state === state),
          )
          .map(pullBody),
      );
    }
    if (method === "GET" && first === "pulls" && rest.length === 2) {
      const pull = pulls.find((p) => String(p.number) === second);
      return pull === undefined ? notFound() : json(200, pullBody(pull));
    }
    // A PR's commits: the one the app wrote on its branch, authored by the app's bot.
    if (method === "GET" && first === "pulls" && rest.length === 3 && third === "commits") {
      const pull = pulls.find((p) => String(p.number) === second);
      return pull === undefined
        ? notFound()
        : json(200, [{ sha: NEW_COMMIT, author: { login: APP_BOT, type: "Bot" } }]);
    }
    return notFound();
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    if (!log && method !== "GET") {
      throw new Error(
        `the GitHub fake refused ${method} ${url.pathname}: E2E_FAKE_GITHUB_LOG is unset in this process, so no ` +
          "test could see the call. Only the server's calls are logged; a Scan Job's writes aren't faked.",
      );
    }
    const text = await request.text();
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const logged: Logged = { method, path: url.pathname + url.search, body };
    if (log) appendFileSync(log, `${JSON.stringify(logged)}\n`);

    if (url.hostname !== "api.github.com") return notFound();
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const fields =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (method === "GET" && url.pathname === "/app") {
      return json(200, { id: 1, slug: APP_SLUG, name: "Warden writer (e2e)" });
    }
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(201, {
        token: "ghs_e2e_fake_installation_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: WRITE_APP_PERMISSIONS,
        repository_selection: "selected",
      });
    }
    if (method === "GET" && parts[0] === "repositories" && parts.length === 2) {
      return parts[1] === String(DAHLIA_REPO.githubId)
        ? json(200, { id: DAHLIA_REPO.githubId, full_name: fullName, default_branch: "main" })
        : notFound();
    }
    if (parts[0] === "repos" && `${parts[1]}/${parts[2]}` === fullName) {
      return onRepo(method, parts.slice(3), url, fields);
    }
    return notFound();
  };
}

/**
 * A `fetch` that sends GitHub's hosts to `handle` and every other address to `passOn`. As `fetch` does, it answers
 * every input with a promise: an address it can't read rejects, never throws.
 */
export function fakeFetch(
  handle: (request: Request) => Promise<Response>,
  passOn: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    // Read without building a Request: one built from a Request would use up the body passed on.
    const address = input instanceof Request ? input.url : String(input);
    return GITHUB_HOSTS.has(new URL(address).hostname)
      ? handle(new Request(input, init))
      : passOn(input, init);
  };
}
