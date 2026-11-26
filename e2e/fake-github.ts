// GitHub as the browser tests' server sees it (#224, story 6): loaded with `--import` into the server and each Scan
// Job it starts (the global setup's NODE_OPTIONS), it replaces `globalThis.fetch` for https://api.github.com and
// https://github.com, and passes every other address on. No process that loads it can reach GitHub: the browser
// tests' own processes load it too, through `session.ts`, and only ever call the server.
//
// It answers the write app's calls on the one repo it knows, `DAHLIA_REPO` (`github-writer.ts`), and the app's own
// read (`GET /app`, which a Setup page's install link is built from); anything else on those hosts answers 404. It
// keeps the branches made (`main` from the start) and the PRs opened, each open until a test says otherwise, for as
// long as the process runs. Each call it answers is appended to the file `E2E_FAKE_GITHUB_LOG` names, as one JSON
// line of its method, path (with its query) and JSON body, never its headers, so never its Authorization; with that
// variable unset it still answers, and logs nothing. Only `node:` modules are imported: Node loads this file as it
// is, types stripped.
import { appendFileSync } from "node:fs";

/** One call the fake answered, as it logs it. `body` is the request's JSON body, or null when it had none. */
export type Logged = { method: string; path: string; body: unknown };

/** The one repo the fake knows, by its URL and GitHub id: Dahlia's Repo Asset (`session.ts`). */
export const DAHLIA_REPO = { ref: "https://github.com/dahlia/agent-tools", githubId: 9301 };

/** The permissions the fake's installation tokens hold: exactly the write app's (`write-grant-routes.ts`). */
const WRITE_APP_PERMISSIONS = { contents: "write", pull_requests: "write", metadata: "read" };

/** The commit `main` points at from the start. */
const MAIN_HEAD = "0123456789abcdef0123456789abcdef01234567";

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
 * to the file `log` names, when it's set, before it's answered.
 */
export function createFakeGitHub({ log }: { log?: string | undefined } = {}) {
  const fullName = new URL(DAHLIA_REPO.ref).pathname.slice(1);
  const branches = new Map([["main", MAIN_HEAD]]);
  const pulls: Pull[] = [];

  const pullBody = (pull: Pull) => ({
    number: pull.number,
    state: pull.state,
    html_url: `${DAHLIA_REPO.ref}/pull/${pull.number}`,
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
      const commit = "fedcba9876543210fedcba9876543210fedcba98";
      branches.set(branch, commit);
      return json(201, { content: { path: rest.slice(1).join("/") }, commit: { sha: commit } });
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
              (head === null || `${fullName.split("/")[0]}:${pull.head}` === head) &&
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
    return notFound();
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const logged: Logged = { method: request.method, path: url.pathname + url.search, body };
    if (log) appendFileSync(log, `${JSON.stringify(logged)}\n`);

    if (url.hostname !== "api.github.com") return notFound();
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const fields =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const method = request.method;
    if (method === "GET" && url.pathname === "/app") {
      return json(200, { id: 1, slug: "warden-writer", name: "Warden writer (e2e)" });
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

/** Replaces `globalThis.fetch` in this process: GitHub's hosts go to one fake, every other address as before. */
function install() {
  const passOn = globalThis.fetch;
  const handle = createFakeGitHub({ log: process.env.E2E_FAKE_GITHUB_LOG });
  globalThis.fetch = (input, init) => {
    // Read without building a Request: one built from a Request would use up the body passed on.
    const address = input instanceof Request ? input.url : String(input);
    return GITHUB_HOSTS.has(new URL(address).hostname)
      ? handle(new Request(input, init))
      : passOn(input, init);
  };
}

install();
