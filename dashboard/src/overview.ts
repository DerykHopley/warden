// The Team's Level, trend and audit answer as the server answers them (GET /api/overview), and the Overview's rules:
// each journey card's state and next step, the trend line's words, and the audit answer's line, its rows by Catalogue,
// the Verdict each row shows and the Control the address focuses (docs/design.md, Components: Journey card, Trend
// line, Audit answer, Audit Control row).
import {
  hasReview,
  Level,
  OverviewBody,
  type AuditAnswer,
  type AuditCatalogue,
  type AuditControl,
  type ControlDetail,
  type ReviewedVerdict,
} from "@warden/contracts";
import { useCallback } from "react";
import { askAboutTeam, callWarden, parsed, type GetToken, type Refused } from "./api.ts";
import { dayWords } from "./date-words.ts";
import { LEVEL_WORDS } from "./finding-words.ts";
import { useWardenCall } from "./warden-call.tsx";

export type OverviewResult =
  /** The overview of `body.team`, the Team the server answered about. */
  | { kind: "overview"; body: OverviewBody }
  /** 403: the session has no Team (its active Organization went away). */
  | { kind: "no-team" }
  /** 409: the Team's Admin hasn't opened Warden yet. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchOverview(getToken: GetToken): Promise<OverviewResult> {
  const res = await callWarden(getToken, "/api/overview");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, OverviewBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "overview", body };
}

/**
 * GET /api/overview for the person's Team, as the Overview's call: an answer about a Team they just switched away from
 * is asked again, then counts as not answering.
 */
export function useOverview(getToken: GetToken, team: string | null, onSessionEnded: () => void) {
  const ask = useCallback(
    (signal: AbortSignal) =>
      askAboutTeam(
        () => fetchOverview(getToken),
        (result) => (result.kind === "overview" ? result.body.team : undefined),
        team,
        signal,
      ),
    [getToken, team],
  );
  return useWardenCall<OverviewResult>(ask, onSessionEnded);
}

/** A journey card's state, always said in words too: the Team's Level is current, one before it done. */
export type JourneyState = "done" | "current" | "not-started";

export const JOURNEY_STATE_WORDS: Record<JourneyState, string> = {
  done: "Done",
  current: "Current",
  "not-started": "Not started",
};

/** One journey card: its Level, what that Level adds, its state, its bar (0 to 100) and the lines under it. */
export type JourneyCardView = {
  level: Level;
  word: string;
  adds: string;
  state: JourneyState;
  progress: number;
  notes: string[];
};

const ADDS: Record<Level, string> = {
  quick: "Repo scan and top fixes",
  standard: "Agent hook and the Judge",
  audit_ready: "Evidence for an audit",
};

/** `count` of what `one` names, in the singular or plural: "1 Gap", "2 Gaps". */
const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The Audit-ready card's note: how many judged Controls have a review, counted as the Level counts them, with those
 * changed since review named, as the answer line counts them waiting; none to review when the Catalogues on judge no
 * Control, as the answer line says; or, with no Catalogue on, the step that starts it.
 */
function controlsReviewedNote(audit: AuditAnswer): string {
  if (audit.answer === "no_catalogue") return "Next: an Admin turns on a Catalogue";
  const all = audit.controls.length;
  if (all === 0) return "No Controls to review";
  const withReview = audit.controls.filter(({ review_state }) => hasReview(review_state)).length;
  const changed = audit.controls.filter(
    ({ review_state }) => review_state === "changed_since_review",
  ).length;
  const note = `${withReview} of ${counted(all, "Control")} ${all === 1 ? "has" : "have"} a review`;
  return changed > 0 ? `${note}, ${changed} changed since` : note;
}

/** Quick's next step while the Team has no Scan, whether Quick is current or passed without one. */
const NO_SCAN_YET = { progress: 0, notes: ["Next: the first Scan"] };

/**
 * The three journey cards, Quick, Standard, Audit-ready, for a Team at `level`: a Level after it not started (an
 * empty bar); a Level before it done (a full bar) only when its own rule holds, as the Level can pass it without:
 * Audit-ready is reached on reviews alone. Quick's one part in the foundation is a Scan, so while current its bar
 * and next step follow `lastScanAt`, and before the Level it is done only with a Scan, otherwise not started with the
 * first Scan as its next step. Standard has no parts yet, and Warden has no Standard rule: at Audit-ready it is not
 * started, never done, and says so. Audit-ready's note counts the Controls with a review in `audit`; current, its bar
 * is full, as the Level needs every Control reviewed.
 */
export function journeyCards(
  level: Level,
  lastScanAt: string | null,
  audit: AuditAnswer,
): JourneyCardView[] {
  const at = Level.options.indexOf(level);
  return Level.options.map((cardLevel, i) => {
    const state: JourneyState = i < at ? "done" : i === at ? "current" : "not-started";
    const card = { level: cardLevel, word: LEVEL_WORDS[cardLevel], adds: ADDS[cardLevel], state };
    if (cardLevel === "quick" && state === "done" && lastScanAt === null) {
      return { ...card, state: "not-started", ...NO_SCAN_YET };
    }
    if (cardLevel === "standard" && level === "audit_ready") {
      return {
        ...card,
        state: "not-started",
        progress: 0,
        notes: ["Warden doesn't check this yet."],
      };
    }
    if (cardLevel === "audit_ready") {
      return {
        ...card,
        progress: state === "current" ? 100 : 0,
        notes: [controlsReviewedNote(audit)],
      };
    }
    if (state === "done") return { ...card, progress: 100, notes: [] };
    if (state === "not-started" || cardLevel !== "quick")
      return { ...card, progress: 0, notes: [] };
    if (lastScanAt === null) return { ...card, ...NO_SCAN_YET };
    return {
      ...card,
      progress: 100,
      notes: [
        `Last Scan: ${dayWords(lastScanAt)}`,
        "Next: Standard adds the agent hook and the Judge",
      ],
    };
  });
}

/** The audit section's line with no Catalogue on, shown muted, as before Vouch answered. */
export const NO_CATALOGUE_LINE =
  "Warden can answer this at Audit-ready, once Vouch checks your Controls.";

/**
 * The answer to "Are we ready for the audit?" in one line: yes, with every Control reviewed; not yet, with its Gaps
 * and the Controls waiting for a review, a part at 0 left out; or, with no Catalogue on, when Warden can answer.
 */
export function auditAnswerLine(audit: AuditAnswer): string {
  switch (audit.answer) {
    case "no_catalogue":
      return NO_CATALOGUE_LINE;
    case "yes": {
      const all = audit.controls.length;
      return all === 1
        ? "Yes: the 1 Control is reviewed, with no Gaps."
        : `Yes: all ${all} Controls are reviewed, with no Gaps.`;
    }
    case "not_yet": {
      const parts = [
        ...(audit.gaps > 0 ? [counted(audit.gaps, "Gap")] : []),
        ...(audit.waiting > 0 ? [`${counted(audit.waiting, "Control")} waiting for review`] : []),
      ];
      return `Not yet: ${parts.length > 0 ? parts.join(", ") : "no Controls to review"}.`;
    }
  }
}

/** One Catalogue on and its judged Controls, as the audit section shows them under its name. */
export type CatalogueControls = { catalogue: AuditCatalogue; controls: AuditControl[] };

/**
 * Each Catalogue the answer lists, in its order, with its own rows in the answer's order: one that judges no Control
 * has none, and a row of a Catalogue the answer doesn't list is dropped.
 */
export function controlsByCatalogue(audit: AuditAnswer): CatalogueControls[] {
  return audit.catalogues.map((catalogue) => ({
    catalogue,
    controls: audit.controls.filter((control) => control.catalogue === catalogue.id),
  }));
}

/** The Control the Overview's address names (`?catalogue=…&control=…`); null unless it names both. */
export type ControlInAddress = { catalogue: string; ref: string } | null;

export function controlInAddress(search: string): ControlInAddress {
  const query = new URLSearchParams(search);
  const catalogue = query.get("catalogue");
  const ref = query.get("control");
  return catalogue && ref ? { catalogue, ref } : null;
}

/**
 * The address's query with `control` in focus (`?catalogue=vda-isa-2027.1&control=1.3.3`), or with none: only those
 * two params change, the others stay as they are, and a query that already says so comes back unchanged.
 */
export function searchWithControl(search: string, control: ControlInAddress): string {
  const query = new URLSearchParams(search);
  const current = controlInAddress(search);
  const unchanged =
    control === null
      ? !query.has("catalogue") && !query.has("control")
      : current?.catalogue === control.catalogue && current.ref === control.ref;
  if (unchanged) return search;
  if (control === null) {
    query.delete("catalogue");
    query.delete("control");
  } else {
    query.set("catalogue", control.catalogue);
    query.set("control", control.ref);
  }
  const rest = query.toString();
  return rest === "" ? "" : `?${rest}`;
}

/** The Catalogue and row that `control` names, when the answer holds both; null otherwise. */
export function focusedControl(
  audit: AuditAnswer,
  control: ControlInAddress,
): { catalogue: AuditCatalogue; control: AuditControl } | null {
  if (control === null) return null;
  const catalogue = audit.catalogues.find(({ id }) => id === control.catalogue);
  const row = audit.controls.find(
    (row) => row.catalogue === control.catalogue && row.ref === control.ref,
  );
  return catalogue === undefined || row === undefined ? null : { catalogue, control: row };
}

/** A focused Control as the answer held it: its Catalogue and its row. */
export type FocusedControl = NonNullable<ReturnType<typeof focusedControl>>;

/**
 * The Overview's notice when an answer asked for again no longer holds the focused Control `gone` (#395), naming it by
 * its ref: with `reviewed`, the Done words of a review the card stored, that it's stored; then why the Overview no
 * longer shows it, naming its Catalogue when `audit` no longer lists that.
 */
export function controlGoneNotice(
  gone: FocusedControl,
  audit: AuditAnswer,
  reviewed: string | null,
): string {
  const { ref } = gone.control;
  const off = audit.catalogues.every(({ id }) => id !== gone.catalogue.id);
  const name = gone.catalogue.name;
  if (reviewed !== null) {
    return off
      ? `${reviewed} Your review of ${ref} is stored, but ${name} is off now, so the Overview doesn't show it.`
      : `${reviewed} Your review of ${ref} is stored, but the Overview no longer shows it.`;
  }
  return off
    ? `${ref} is no longer on the Overview: ${name} is off now.`
    : `${ref} is no longer on the Overview.`;
}

/** Whether `control` names the Control `focus` is. */
export const namesControl = (control: ControlInAddress, focus: FocusedControl) =>
  control?.catalogue === focus.catalogue.id && control.ref === focus.control.ref;

/** Whether a row says what the Control's read says: the same Verdicts and review state. */
export const rowAgrees = (
  row: AuditControl,
  read: Pick<ControlDetail, "verdict" | "review_state" | "reviewed_verdict">,
) =>
  row.verdict === read.verdict &&
  row.review_state === read.review_state &&
  row.reviewed_verdict === read.reviewed_verdict;

/**
 * The Verdict a Control's row shows: the reviewed one while the Control is reviewed, and the one worked out now
 * otherwise (not reviewed, changed since review, or a reviewed row with no reviewed Verdict). The Control card's
 * `ControlDetail` passes too.
 */
export function shownVerdict(
  control: Pick<AuditControl, "verdict" | "review_state" | "reviewed_verdict">,
): ReviewedVerdict {
  return control.review_state === "reviewed" && control.reviewed_verdict !== null
    ? control.reviewed_verdict
    : control.verdict;
}

/**
 * The Fix rate as a whole percent, rounded down so it never claims 100% before everything is fixed, and at least 1%
 * once anything is, so a fix never reads as 0%.
 */
function fixRatePercent({ fixed, of }: OverviewBody["fix_rate"]): number {
  const percent = Math.floor((fixed * 100) / of);
  return fixed > 0 ? Math.max(1, percent) : percent;
}

/**
 * The Overview's trend, one line: where Open Findings went over the period, and the Fix rate as a whole percent. With
 * nothing to fix the rate is left out; with no Findings at all and no Scan, the trend hasn't started.
 */
export function trendLine(body: OverviewBody): string {
  const { open_at_start: from, open_now: to, period_days: days, fix_rate } = body;
  if (!body.has_findings && body.last_scan_at === null) {
    return "No Findings yet: the trend starts after the first Scan.";
  }
  const moved =
    from === to
      ? `Open Findings stayed at ${to} over ${days} days`
      : `Open Findings went from ${from} to ${to} in ${days} days`;
  if (fix_rate.of === 0) return `${moved}.`;
  return `${moved}; fix rate ${fixRatePercent(fix_rate)}%.`;
}
