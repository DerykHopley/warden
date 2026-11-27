// Vouch's Catalogues (spec #341, slices 5 to 7a): the calls Setup's Catalogues section makes, reading every Catalogue
// as the Team sees it and an Admin's switch turning one on or off, the watch that rereads them after a switch a Team
// switch dropped, a Control's Verdict and review state in words, and the Control card's read and its lines.
import {
  CataloguesBody,
  ControlDetail,
  TeamCatalogue,
  type CatalogueId,
  type ControlReview,
  type ControlRuleEvidence,
  type ReviewedVerdict,
  type ReviewState,
} from "@warden/contracts";
import {
  callWarden,
  parsed,
  serverError,
  type GetToken,
  type Refused,
  type TeamRefusal,
} from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { shownVerdict } from "./overview.ts";
import { confirmTeam, type TeamCheckRefused } from "./products.ts";

/** Setup's Catalogues heading's id, the anchor the Overview's Setup pointer lands on (`/setup#setup-catalogues`). */
export const CATALOGUES_ANCHOR = "setup-catalogues";

/** A Control's Verdict, worked out or reviewed, in words. */
export const VOUCH_VERDICT_WORDS: Record<ReviewedVerdict, string> = {
  evidenced: "Evidenced",
  partly_evidenced: "Partly evidenced",
  not_evidenced: "Not evidenced",
  not_applicable: "Not applicable",
};

/** A Control's review state in words. */
export const REVIEW_STATE_WORDS: Record<ReviewState, string> = {
  not_reviewed: "Not reviewed",
  reviewed: "Reviewed",
  changed_since_review: "Changed since review",
};

export type CataloguesResult =
  { kind: "catalogues"; catalogues: TeamCatalogue[] } | TeamRefusal | Refused;

/** `GET /api/vouch/catalogues`: every Catalogue Warden has, as the Team sees it, read by anyone in it. */
export async function fetchCatalogues(getToken: GetToken): Promise<CataloguesResult> {
  const res = await callWarden(getToken, "/api/vouch/catalogues");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, CataloguesBody);
  return body === undefined
    ? { kind: "not-answering" }
    : { kind: "catalogues", catalogues: body.catalogues };
}

export type SwitchResult =
  | { kind: "switched"; catalogue: TeamCatalogue }
  /** 403: the person isn't an Admin (any more), or has no Team. */
  | { kind: "forbidden" }
  /** 400 or 404: nothing was changed, in the server's words. */
  | { kind: "refused"; words: string }
  | { kind: "team-not-opened" }
  | Refused;

/** `PUT /api/vouch/catalogues/:id` (an Admin's): turns the Catalogue on or off for the Team. */
export async function switchCatalogue(
  getToken: GetToken,
  id: CatalogueId,
  on: boolean,
): Promise<SwitchResult> {
  const res = await callWarden(getToken, `/api/vouch/catalogues/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { on },
  });
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 400 || res.status === 404) {
    return { kind: "refused", words: (await serverError(res)) ?? "Nothing was changed." };
  }
  if (res.status === 409) return { kind: "team-not-opened" };
  const catalogue = await parsed(res, TeamCatalogue);
  return catalogue === undefined ? { kind: "not-answering" } : { kind: "switched", catalogue };
}

/**
 * Switches as `switchCatalogue` does, but only once /api/me says the session is in `team`, the Team Setup was opened
 * in, and with the token that answer was asked with (`confirmTeam`), as a Product save does: a switch is never sent
 * with a token for the Team just left. While /api/me names another Team, or gives no answer, nothing is sent.
 */
export async function switchCatalogueInTeam(
  getToken: GetToken,
  team: string | null,
  id: CatalogueId,
  on: boolean,
): Promise<SwitchResult | TeamCheckRefused> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  return switchCatalogue(inTeam.getToken, id, on);
}

/** The Setup pages shown now, each told when a dropped switch changed a Team's Catalogues. */
const cataloguesWatchers = new Set<(team: string | null) => void>();

/**
 * Calls `watcher` with the Team whenever a switch a Team switch dropped changed that Team's Catalogues; it returns the
 * call that stops it. A Team switch mounts a fresh Setup page, so the page that sent a switch may be gone by the time
 * its answer arrives: the page shown then is the one that reads the Catalogues again.
 */
export function watchCatalogues(watcher: (team: string | null) => void): () => void {
  cataloguesWatchers.add(watcher);
  return () => cataloguesWatchers.delete(watcher);
}

/** Tells each Setup page shown now that `team`'s Catalogues changed. */
export function cataloguesChanged(team: string | null): void {
  for (const watcher of cataloguesWatchers) watcher(team);
}

export type ControlResult =
  | { kind: "control"; detail: ControlDetail }
  /** 404: Warden has no such Catalogue, or it doesn't judge this Control; the server's words, null with none. */
  | { kind: "not-found"; error: string | null }
  | Refused;

/**
 * `GET /api/vouch/catalogues/:id/controls/:ref`: one Control with its evidence and its reviews, read by anyone in the
 * Team. A 403, a 409, a 5xx and a body that doesn't parse are all not answering: the card offers Retry for each.
 */
export async function fetchControl(
  getToken: GetToken,
  catalogue: CatalogueId,
  ref: string,
): Promise<ControlResult> {
  const res = await callWarden(
    getToken,
    `/api/vouch/catalogues/${encodeURIComponent(catalogue)}/controls/${encodeURIComponent(ref)}`,
  );
  if (!(res instanceof Response)) return res;
  if (res.status === 404) return { kind: "not-found", error: await serverError(res) };
  const detail = await parsed(res, ControlDetail);
  return detail === undefined ? { kind: "not-answering" } : { kind: "control", detail };
}

/**
 * Reads as `fetchControl` does, but only once /api/me says the session is in `team`, and with the token that answer was
 * asked with (`confirmTeam`), as the Patch section reads: the answer names no Team, and right after a Team switch Clerk
 * can still hand out a token for the Team just left. Too many sign-ins reads as a 429; a Team not opened, as no answer.
 */
export async function fetchControlInTeam(
  getToken: GetToken,
  team: string | null,
  catalogue: CatalogueId,
  ref: string,
): Promise<ControlResult> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind === "confirmed") return fetchControl(inTeam.getToken, catalogue, ref);
  if (inTeam.kind === "too-many-sign-ins") {
    return { kind: "too-many-attempts", retryAfter: inTeam.retryAfter };
  }
  return inTeam.kind === "team-not-opened" ? { kind: "not-answering" } : inTeam;
}

export const CONTROL_LOADING = "Loading the Control…";
export const CONTROL_FAILED = "Couldn't load the Control.";
/** A 404 whose body names no reason. */
export const NO_CONTROL = "Warden doesn't judge this Control.";
/** Under the reason while the Control is changed since review (story 7). */
export const VERDICT_CHANGED = "The Verdict worked out now differs from the one last reviewed.";
export const NO_OPEN_FINDINGS = "No Open Findings.";
export const NO_REVIEWS = "No reviews yet.";

const ASSET_COUNT_WORDS: Record<ControlRuleEvidence["asset_kind"], [string, string]> = {
  repo: ["Repo", "Repos"],
  product: ["Product", "Products"],
};

/**
 * One Rule's evidence after its id: "last covered Nov 24, 2026, 9:14 AM, on 2 of 3 Repos", or "no Scan in the last 30
 * days, on 0 of 3 Repos"; the kind in the singular when the Team holds one.
 */
export function ruleEvidenceWords(rule: ControlRuleEvidence): string {
  const covered =
    rule.last_covered_at === null
      ? "no Scan in the last 30 days"
      : `last covered ${dayAndTimeWords(rule.last_covered_at)}`;
  const [one, many] = ASSET_COUNT_WORDS[rule.asset_kind];
  return `${covered}, on ${rule.assets_covered} of ${rule.assets_held} ${rule.assets_held === 1 ? one : many}`;
}

/** The evidence of a Control a Judge run evidences (5.2.4): the newest run in the last 30 days, or none. */
export const judgeRunLine = (runAt: string | null) =>
  runAt === null
    ? "No Judge run in the last 30 days."
    : `Last Judge run: ${dayAndTimeWords(runAt)}`;

/**
 * The line under the Verdict: the server's reason, which explains the worked-out Verdict. While a reviewed Verdict
 * replaces that one (`shownVerdict`), it says which Verdict it explains: "Worked out as Not evidenced: …".
 */
export function verdictReasonLine(
  detail: Pick<ControlDetail, "verdict" | "reason" | "review_state" | "reviewed_verdict">,
): string {
  return shownVerdict(detail) === detail.verdict
    ? detail.reason
    : `Worked out as ${VOUCH_VERDICT_WORDS[detail.verdict]}: ${detail.reason}`;
}

/** A review's outcome: "Confirmed: Partly evidenced", or "Overridden to Not applicable, from Not evidenced". */
export function reviewOutcomeLine(review: ControlReview): string {
  const verdict = VOUCH_VERDICT_WORDS[review.verdict];
  return review.outcome === "confirmed"
    ? `Confirmed: ${verdict}`
    : `Overridden to ${verdict}, from ${VOUCH_VERDICT_WORDS[review.worked_out_verdict]}`;
}
