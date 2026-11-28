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
  /** GET /api/github/write-app: the write app's slug and client id. */
  writeApp?: () => Answer;
  /** GET /api/github/write-grant: the Team's write grants. */
  writeGrant?: () => Answer;
  /** POST /api/github/write-installations, with the parsed body. */
  grantWrite?: (body: unknown) => Answer;
  /** POST /api/scans, with the parsed body. */
  startScan?: (body: unknown) => Answer;
  products?: () => Answer;
  /** GET /api/patch/frameworks. */
  frameworks?: () => Answer;
  /** GET /api/patch/findings/:id/assessment, with the Finding id. */
  assessment?: (id: string) => Answer;
  /** GET /api/guard/findings/:id/fix-pr, with the Finding id: whether it's fixable, and its Fix PR. */
  fixPr?: (id: string) => Answer;
  /** POST /api/guard/findings/:id/fix-pr, with the Finding id and the parsed body (none: undefined). */
  openFixPr?: (id: string, body: unknown) => Answer;
  /** GET /api/guard/findings/:id/session, with the Finding id: its Agent session's record. */
  sessionRecord?: (id: string) => Answer;
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
  /** GET /api/vouch/catalogues: every Catalogue Warden has, as the Team sees it. */
  catalogues?: () => Answer;
  /** PUT /api/vouch/catalogues/:id, with the Catalogue id and the parsed body. */
  switchCatalogue?: (id: string, body: unknown) => Answer;
  /** GET /api/vouch/catalogues/:id/controls/:ref, with the Catalogue id and the Control's ref. */
  control?: (catalogue: string, ref: string) => Answer;
  /** POST /api/vouch/catalogues/:id/controls/:ref/reviews, with the Catalogue id, the Control's ref and the parsed body. */
  review?: (catalogue: string, ref: string, body: unknown) => Answer;
  /** GET /api/hook: the Team's hook settings (story 7), never a token. */
  hook?: () => Answer;
  /** POST /api/hook/token: issues or rotates the Team's hook token. */
  issueHookToken?: () => Answer;
  /** PUT /api/hook/privacy-tier, with the parsed body. */
  setPrivacyTier?: (body: unknown) => Answer;
  /** GET /api/judge/model: the Team's own Judge model, or null (spec #225, story 10). */
  judgeModel?: () => Answer;
  /** PUT /api/judge/model, with the parsed body. */
  setJudgeModel?: (body: unknown) => Answer;
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
    if (url === "/api/github/write-app" && method === "GET" && routes.writeApp) {
      return routes.writeApp();
    }
    if (url === "/api/github/write-grant" && method === "GET" && routes.writeGrant) {
      return routes.writeGrant();
    }
    if (url === "/api/github/write-installations" && method === "POST" && routes.grantWrite) {
      return routes.grantWrite(sentBody(init));
    }
    if (url === "/api/scans" && method === "POST" && routes.startScan) {
      return routes.startScan(sentBody(init));
    }
    if (url === "/api/products" && method === "GET" && routes.products) return routes.products();
    if (url === "/api/patch/frameworks" && method === "GET" && routes.frameworks) {
      return routes.frameworks();
    }
    const assessed = /^\/api\/patch\/findings\/([^/]+)\/assessment$/.exec(url);
    if (assessed && method === "GET" && routes.assessment) {
      return routes.assessment(decodeURIComponent(assessed[1] ?? ""));
    }
    const fixPr = /^\/api\/guard\/findings\/([^/]+)\/fix-pr$/.exec(url);
    if (fixPr && method === "GET" && routes.fixPr) {
      return routes.fixPr(decodeURIComponent(fixPr[1] ?? ""));
    }
    if (fixPr && method === "POST" && routes.openFixPr) {
      return routes.openFixPr(decodeURIComponent(fixPr[1] ?? ""), sentBody(init));
    }
    const sessionRecord = /^\/api\/guard\/findings\/([^/]+)\/session$/.exec(url);
    if (sessionRecord && method === "GET" && routes.sessionRecord) {
      return routes.sessionRecord(decodeURIComponent(sessionRecord[1] ?? ""));
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
    if (url === "/api/vouch/catalogues" && method === "GET" && routes.catalogues) {
      return routes.catalogues();
    }
    const onCatalogue = /^\/api\/vouch\/catalogues\/([^/]+)$/.exec(url);
    if (onCatalogue && method === "PUT" && routes.switchCatalogue) {
      return routes.switchCatalogue(decodeURIComponent(onCatalogue[1] ?? ""), sentBody(init));
    }
    const onControl = /^\/api\/vouch\/catalogues\/([^/]+)\/controls\/([^/]+)$/.exec(url);
    if (onControl && method === "GET" && routes.control) {
      const [, catalogue = "", ref = ""] = onControl;
      return routes.control(decodeURIComponent(catalogue), decodeURIComponent(ref));
    }
    const reviewed = /^\/api\/vouch\/catalogues\/([^/]+)\/controls\/([^/]+)\/reviews$/.exec(url);
    if (reviewed && method === "POST" && routes.review) {
      const [, catalogue = "", ref = ""] = reviewed;
      return routes.review(decodeURIComponent(catalogue), decodeURIComponent(ref), sentBody(init));
    }
    if (url === "/api/hook" && method === "GET" && routes.hook) return routes.hook();
    if (url === "/api/hook/token" && method === "POST" && routes.issueHookToken) {
      return routes.issueHookToken();
    }
    if (url === "/api/hook/privacy-tier" && method === "PUT" && routes.setPrivacyTier) {
      return routes.setPrivacyTier(sentBody(init));
    }
    if (url === "/api/judge/model" && method === "GET" && routes.judgeModel) {
      return routes.judgeModel();
    }
    if (url === "/api/judge/model" && method === "PUT" && routes.setJudgeModel) {
      return routes.setJudgeModel(sentBody(init));
    }
    throw new Error(`The test gave no answer for ${method} ${url}`);
  });
}

/** The requests made to one path, as [url, init] pairs. */
export const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === path);

/**
 * A promise the test resolves when it chooses, for an answer that arrives late; or rejects, for a call that ends with
 * no answer at all.
 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
