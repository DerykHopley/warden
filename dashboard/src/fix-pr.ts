// A Guard Finding's Fix PR (#224, story 6), for the detail card's Fix PR section: whether the Finding can get one and
// its newest one (GET /api/guard/findings/:id/fix-pr), whether the Team holds a write grant (GET
// /api/github/write-grant), and opening one (POST /api/guard/findings/:id/fix-pr).
import { FindingFixPrBody, FixPrBody, type Finding } from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";
import { fetchWriteGrants } from "./github-setup.ts";
import { confirmTeam, type TeamCheckRefused } from "./products.ts";

export type FixPrResult =
  | { kind: "fix-pr"; fixable: boolean; fixPr: FixPrBody | null }
  /** 404: the Team has no such Finding. */
  | { kind: "not-found" }
  | Refused;

/**
 * `GET /api/guard/findings/:id/fix-pr`. A 403, a 409, a 5xx and a body that doesn't parse are all not answering: the
 * section offers Retry for each. Its `fixable` reads only the Finding's Rule and Location, never its Status.
 */
export async function fetchFixPr(getToken: GetToken, findingId: string): Promise<FixPrResult> {
  const res = await callWarden(getToken, fixPrPath(findingId));
  if (!(res instanceof Response)) return res;
  if (res.status === 404) return { kind: "not-found" };
  const body = await parsed(res, FindingFixPrBody);
  return body === undefined
    ? { kind: "not-answering" }
    : { kind: "fix-pr", fixable: body.fixable, fixPr: body.fix_pr };
}

export type FixPrRead =
  /** `granted`: whether the Team holds a write grant, or null when it wasn't asked (not fixable, or not Open). */
  | { kind: "read"; fixable: boolean; fixPr: FixPrBody | null; granted: boolean | null }
  | { kind: "not-found" }
  | Refused;

/**
 * What the section shows from: the Fix PR read of Finding `findingId`, then, while its `status` is Open and it's
 * fixable, the Team's write grants. Both are asked only once /api/me says the session is in `team`, the Finding's Team,
 * with the token that answer was asked with (`confirmTeam`), as `fetchAssessmentInTeam` asks: neither answer names a
 * Team. While /api/me names another Team, or gives no answer, nothing is asked; its 429 is too many sign-in attempts,
 * and its 409 is not answering. Any refusal of the write grants' read is not answering too.
 */
export async function readFixPrInTeam(
  getToken: GetToken,
  team: string,
  findingId: string,
  status: Finding["status"],
): Promise<FixPrRead> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind === "too-many-sign-ins") {
    return { kind: "too-many-attempts", retryAfter: inTeam.retryAfter };
  }
  if (inTeam.kind === "team-not-opened") return { kind: "not-answering" };
  if (inTeam.kind !== "confirmed") return inTeam;

  const read = await fetchFixPr(inTeam.getToken, findingId);
  if (read.kind !== "fix-pr") return read;
  if (!read.fixable || status !== "open") {
    return { kind: "read", fixable: read.fixable, fixPr: read.fixPr, granted: null };
  }
  const grants = await fetchWriteGrants(inTeam.getToken);
  if (grants.kind === "no-team" || grants.kind === "team-not-opened") {
    return { kind: "not-answering" };
  }
  if (grants.kind !== "grants") return grants;
  return {
    kind: "read",
    fixable: true,
    fixPr: read.fixPr,
    granted: grants.grants.length > 0,
  };
}

export type OpenFixPrResult =
  /** 201: GitHub opened a new Fix PR. */
  | { kind: "opened"; fixPr: FixPrBody }
  /** 200: the Finding's Fix PR is still open, and no new one was opened. */
  | { kind: "still-open"; fixPr: FixPrBody }
  /** 409: the Finding, the grant or the repo changed (not Open, no write grant, an uninstalled app, …). */
  | { kind: "conflict"; error: string | null }
  /** 400, 403, 502, 503 or another 4xx: no Fix PR was opened, in the server's words when it gave them. */
  | { kind: "refused"; error: string | null }
  | { kind: "not-found" }
  /** No answer, a 5xx the server doesn't word, or a 2xx that doesn't parse: a Fix PR may have been opened. */
  | { kind: "maybe-opened" }
  /** 429: the Team opened too many Fix PRs this hour. Named apart from a read's `too-many-attempts`, a sign-in limit. */
  | { kind: "too-many-fix-prs"; retryAfter: number | null }
  | { kind: "session-ended" };

/** `POST /api/guard/findings/:id/fix-pr`, with no body. The server may wait for GitHub, for several seconds. */
export async function openFixPr(getToken: GetToken, findingId: string): Promise<OpenFixPrResult> {
  const res = await callWarden(getToken, fixPrPath(findingId), { method: "POST" });
  if (!(res instanceof Response)) {
    if (res.kind === "not-answering") return { kind: "maybe-opened" };
    if (res.kind === "too-many-attempts")
      return { kind: "too-many-fix-prs", retryAfter: res.retryAfter };
    return res;
  }
  if (res.status === 201 || res.status === 200) {
    const fixPr = await parsed(res, FixPrBody);
    if (fixPr === undefined) return { kind: "maybe-opened" };
    return { kind: res.status === 201 ? "opened" : "still-open", fixPr };
  }
  if (res.status === 404) return { kind: "not-found" };
  if (res.status === 409) return { kind: "conflict", error: await serverError(res) };
  if ((res.status >= 400 && res.status < 500) || res.status === 502 || res.status === 503) {
    return { kind: "refused", error: await serverError(res) };
  }
  return { kind: "maybe-opened" };
}

/**
 * Opens as `openFixPr` does, but only once /api/me says the session is in `team`, the Finding's Team, and with the
 * token that answer was asked with (`confirmTeam`), as a Product save does: a Fix PR is never sent with a token for the
 * Team just left. While /api/me names another Team, or gives no answer, nothing is sent.
 */
export async function openFixPrInTeam(
  getToken: GetToken,
  team: string,
  findingId: string,
): Promise<OpenFixPrResult | TeamCheckRefused> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  return openFixPr(inTeam.getToken, findingId);
}

const fixPrPath = (findingId: string) =>
  `/api/guard/findings/${encodeURIComponent(findingId)}/fix-pr`;
