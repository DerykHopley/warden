// Fakes Warden's server for the dashboard's tests: each route answers what the test gives it.
import { vi } from "vitest";

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A 204: no body, as a delete answers. */
export const noContent = () => new Response(null, { status: 204 });

type Answer = Response | Promise<Response>;

export type Routes = {
  me?: () => Answer;
  members?: () => Answer;
  findings?: () => Answer;
  proposals?: () => Answer;
  overview?: () => Answer;
  githubApp?: () => Answer;
  repos?: () => Answer;
  /** POST /api/github/installations, with the parsed body. */
  linkInstallation?: (body: unknown) => Answer;
  products?: () => Answer;
  /** GET /api/patch/frameworks. */
  frameworks?: () => Answer;
  /** GET /api/patch/findings/:id/assessment, with the Finding id. */
  assessment?: (id: string) => Answer;
  /** POST /api/products (id null) or PUT /api/products/:id, with the Product id and the parsed body. */
  saveProduct?: (id: string | null, body: unknown) => Answer;
  /** DELETE /api/products/:id, with the Product id. */
  deleteProduct?: (id: string) => Answer;
  /** PUT /api/team/members/:userId/role, with the user id and the parsed body. */
  changeRole?: (userId: string, body: unknown) => Answer;
  /**
   * POST /api/findings/:id/<action> (accept, false-positive, confirm-fix, mark-moved, reopen, proposals), with the
   * Finding id, the action and the parsed body.
   */
  findingAction?: (id: string, action: string, body: unknown) => Answer;
  /** POST /api/proposals/:id/<approve or reject>, with the Proposal id, the action and the parsed body (none: undefined). */
  proposalAction?: (id: string, action: string, body: unknown) => Answer;
};

const sentBody = (init: RequestInit | undefined): unknown =>
  init?.body === undefined ? undefined : JSON.parse(String(init.body));

export const fetchMock = vi.fn<typeof fetch>();

/** Answers each request from `routes`; a route the test didn't give is a test failure, not a silent 404. */
export function serve(routes: Routes) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/me" && method === "GET" && routes.me) return routes.me();
    if (url === "/api/team/members" && method === "GET" && routes.members) return routes.members();
    if (url === "/api/findings" && method === "GET" && routes.findings) return routes.findings();
    if (url === "/api/proposals" && method === "GET" && routes.proposals) return routes.proposals();
    if (url === "/api/overview" && method === "GET" && routes.overview) return routes.overview();
    if (url === "/api/github/app" && method === "GET" && routes.githubApp) {
      return routes.githubApp();
    }
    if (url === "/api/repos" && method === "GET" && routes.repos) return routes.repos();
    if (url === "/api/github/installations" && method === "POST" && routes.linkInstallation) {
      return routes.linkInstallation(sentBody(init));
    }
    if (url === "/api/products" && method === "GET" && routes.products) return routes.products();
    if (url === "/api/patch/frameworks" && method === "GET" && routes.frameworks) {
      return routes.frameworks();
    }
    const assessed = /^\/api\/patch\/findings\/([^/]+)\/assessment$/.exec(url);
    if (assessed && method === "GET" && routes.assessment) {
      return routes.assessment(decodeURIComponent(assessed[1] ?? ""));
    }
    if (url === "/api/products" && method === "POST" && routes.saveProduct) {
      return routes.saveProduct(null, sentBody(init));
    }
    const onProduct = /^\/api\/products\/([^/]+)$/.exec(url);
    if (onProduct && method === "PUT" && routes.saveProduct) {
      return routes.saveProduct(decodeURIComponent(onProduct[1] ?? ""), sentBody(init));
    }
    if (onProduct && method === "DELETE" && routes.deleteProduct) {
      return routes.deleteProduct(decodeURIComponent(onProduct[1] ?? ""));
    }
    const change = /^\/api\/team\/members\/([^/]+)\/role$/.exec(url);
    if (change && method === "PUT" && routes.changeRole) {
      return routes.changeRole(decodeURIComponent(change[1] ?? ""), JSON.parse(String(init?.body)));
    }
    const onFinding = /^\/api\/findings\/([^/]+)\/([a-z-]+)$/.exec(url);
    if (onFinding && method === "POST" && routes.findingAction) {
      const [, id = "", action = ""] = onFinding;
      return routes.findingAction(decodeURIComponent(id), action, sentBody(init));
    }
    const onProposal = /^\/api\/proposals\/([^/]+)\/(approve|reject)$/.exec(url);
    if (onProposal && method === "POST" && routes.proposalAction) {
      const [, id = "", action = ""] = onProposal;
      return routes.proposalAction(decodeURIComponent(id), action, sentBody(init));
    }
    throw new Error(`The test gave no answer for ${method} ${url}`);
  });
}

/** The requests made to one path, as [url, init] pairs. */
export const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === path);

/** A promise the test resolves when it chooses, for an answer that arrives late. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
