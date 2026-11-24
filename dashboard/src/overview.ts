// The Team's Level and trend as the server answers them (GET /api/overview), and the Overview's rules: each journey
// card's state and next step, and the trend line's words (docs/design.md, Components: Journey card, Trend line).
import { Level, OverviewBody } from "@warden/contracts";
import { useCallback } from "react";
import { askAboutTeam, callWarden, parsed, type GetToken, type Refused } from "./api.ts";
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
 * GET /api/overview for the person's Team, as a page's call: an answer about a Team they just switched away from is
 * asked again, then counts as not answering. The Overview and the Findings page's Level line both read it.
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

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * The three journey cards, Quick, Standard, Audit-ready, for a Team at `level`: a Level before it is done (a full
 * bar), after it not started (an empty bar). Quick's one part in the foundation is a Scan, so while current its bar
 * and next step follow `lastScanAt`. Standard and Audit-ready have no parts yet: current, their bar stays empty.
 */
export function journeyCards(level: Level, lastScanAt: string | null): JourneyCardView[] {
  const at = Level.options.indexOf(level);
  return Level.options.map((cardLevel, i) => {
    const state: JourneyState = i < at ? "done" : i === at ? "current" : "not-started";
    const card = { level: cardLevel, word: LEVEL_WORDS[cardLevel], adds: ADDS[cardLevel], state };
    if (state === "done") return { ...card, progress: 100, notes: [] };
    if (state === "not-started" || cardLevel !== "quick")
      return { ...card, progress: 0, notes: [] };
    if (lastScanAt === null) return { ...card, progress: 0, notes: ["Next: the first Scan"] };
    return {
      ...card,
      progress: 100,
      notes: [`Last Scan: ${day(lastScanAt)}`, "Next: Standard adds the agent hook and the Judge"],
    };
  });
}

/**
 * The Overview's trend, one line: where Open Findings went over the period, and the Fix rate as a whole percent. With
 * nothing to fix the rate is left out; with no Findings and no Scan, the trend hasn't started.
 */
export function trendLine(body: OverviewBody): string {
  const { open_at_start: from, open_now: to, period_days: days, fix_rate } = body;
  if (body.last_scan_at === null && from === 0 && to === 0 && fix_rate.of === 0) {
    return "No Findings yet: the trend starts after the first Scan.";
  }
  const moved =
    from === to
      ? `Open Findings stayed at ${to} over ${days} days`
      : `Open Findings went from ${from} to ${to} in ${days} days`;
  if (fix_rate.of === 0) return `${moved}.`;
  return `${moved}; fix rate ${Math.round((fix_rate.fixed / fix_rate.of) * 100)}%.`;
}
