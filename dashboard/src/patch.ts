// One Patch Finding's assessment (GET /api/patch/findings/:id/assessment, spec #101 stories 5 and 6), for the detail
// card's Patch section, and the words it shows for it.
import { PatchAssessment } from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";
import { dayWords } from "./date-words.ts";
import { askInTeam } from "./products.ts";

export type AssessmentResult =
  | { kind: "assessment"; assessment: PatchAssessment }
  /**
   * 404: the id isn't one of the Team's Patch Findings, or the CVE snapshot doesn't hold its CVE; `error` is the
   * server's words, null when its body has none.
   */
  | { kind: "not-found"; error: string | null }
  | Refused;

/**
 * Finding `findingId`'s assessment, worked out by the server now. A 403, a 409, a 5xx and a body that doesn't parse
 * are all not answering: the section offers Retry for each.
 */
export async function fetchAssessment(
  getToken: GetToken,
  findingId: string,
): Promise<AssessmentResult> {
  const res = await callWarden(
    getToken,
    `/api/patch/findings/${encodeURIComponent(findingId)}/assessment`,
  );
  if (!(res instanceof Response)) return res;
  if (res.status === 404) return { kind: "not-found", error: await serverError(res) };
  const assessment = await parsed(res, PatchAssessment);
  return assessment === undefined ? { kind: "not-answering" } : { kind: "assessment", assessment };
}

/**
 * Asks as `fetchAssessment` does, but only once /api/me says the session is in `team`, the Finding's Team
 * (`askInTeam`). The assessment names no Team: asked with a token for the Team just left, the server would answer a
 * 404 that stays on the card. While /api/me names another Team, or gives no answer, nothing is asked and Retry shows;
 * its 409 is not answering, as the assessment's own 409 is.
 */
export const fetchAssessmentInTeam = (
  getToken: GetToken,
  team: string,
  findingId: string,
): Promise<AssessmentResult> =>
  askInTeam(getToken, team, (confirmed) => fetchAssessment(confirmed, findingId));

export const VERDICT_WORDS: Record<PatchAssessment["verdict"], string> = {
  affected: "Affected",
  not_affected: "Not affected",
  unknown: "Can't tell",
};

export const WHO_ACTS_WORDS: Record<NonNullable<PatchAssessment["who_acts"]>, string> = {
  you: "You",
  upstream: "Upstream: the package that brings it in",
  vendor: "The vendor",
};

/** Who acts when no one does: the Product's dependency on the CVE's framework is gone. */
export const NO_ONE_ACTS = "No one now: the Product no longer uses this framework.";

export const LEVEL_WORDS: Record<PatchAssessment["priority"]["level"], string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export const NO_FIX = "No fix listed yet.";
/** One package's line in Fixed in when it has no fixed version. */
export const NO_FIX_FOR_PACKAGE = "no fix listed yet";

export const ASSESSMENT_LOADING = "Loading the CVE assessment…";
export const ASSESSMENT_FAILED = "Couldn't load the CVE assessment.";
/** A 404 whose body names no reason. */
export const NO_ASSESSMENT = "Warden has no CVE assessment for this Finding.";

/** Whether `url` is an https: address: anything else is never made a link. */
export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The assessment's pages as links, NVD's first, then OSV's: "OSV" for one, "OSV 1", "OSV 2" for several, numbered
 * among those shown. A page that isn't https: is left out.
 */
export function assessmentLinks(links: PatchAssessment["links"]): { name: string; href: string }[] {
  const osv = links.osv.filter(isHttps);
  return [
    ...(isHttps(links.nvd) ? [{ name: "NVD", href: links.nvd }] : []),
    ...osv.map((href, i) => ({ name: osv.length > 1 ? `OSV ${i + 1}` : "OSV", href })),
  ];
}

/**
 * A due date (YYYY-MM-DD, a calendar day) as the card says a day: "Jan 15, 2027". Read as the reader's own midnight,
 * so a reader west of UTC sees the same day, not the one before.
 */
export const dueDayWords = (day: string) => dayWords(`${day}T00:00:00`);
