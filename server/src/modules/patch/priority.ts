// Patch's priority (A16): how urgent an open CVE is for a Team, with the reasons and a due date. A pure function,
// ported from the spike `architecture/spikes/stack-ts/patch-p3` (src/priority.ts, status.ts, settings.ts), itself a
// port of Patch's backend/app/priority.py. Same behaviour; the policy is fixed in code (no Team setting).
import type { PriorityLevel, Status } from "@warden/contracts";
import { isNvdSeverity, type NvdSeverity } from "./cvss-band.ts";
import type { VerdictKind } from "./verdict.ts";

export const ALERT_PRIORITY: Readonly<Record<PriorityLevel, number>> = {
  urgent: 5,
  high: 4,
  normal: 3,
  low: 2,
};

/** Days to fix at each priority level, and whether a KEV entry's own deadline replaces them. */
export interface PriorityPolicy {
  readonly urgent_days: number;
  readonly high_days: number;
  readonly normal_days: number;
  readonly low_days: number;
  readonly adopt_kev_deadline: boolean;
}

/** Patch's default policy, the one Warden uses: no Team edits it (spec #101). */
export const PATCH_POLICY: PriorityPolicy = Object.freeze({
  urgent_days: 7,
  high_days: 30,
  normal_days: 90,
  low_days: 180,
  adopt_kev_deadline: true,
});

export interface CveFacts {
  readonly severity: NvdSeverity | "NONE" | null; // NONE or null when NVD hasn't scored it
  readonly kev: boolean;
  readonly epss_percentile: number | null; // 0 to 1, EPSS by FIRST
  readonly verdict: VerdictKind; // whether the CVE touches the version in use (A15)
  readonly internet_facing: boolean;
  readonly status: Status;
  readonly published: string; // YYYY-MM-DD
  readonly kev_added?: string | null; // YYYY-MM-DD
  readonly kev_deadline?: string | null; // YYYY-MM-DD
  readonly review_date?: string | null; // YYYY-MM-DD: an Accepted Finding's expiry
  readonly no_fix?: boolean;
}

export interface Priority {
  readonly level: PriorityLevel;
  readonly reasons: readonly string[];
  readonly row: number; // the priority table's row that matched
  readonly due_date: string;
  readonly due_from: string; // "KEV deadline", "published + 90 days", "added to KEV + 7 days"
  readonly overdue: boolean;
  readonly alert_priority: number;
}

const SEVERITY_REASON: Readonly<Record<NvdSeverity, string>> = {
  CRITICAL: "critical",
  HIGH: "high severity",
  MEDIUM: "medium severity",
  LOW: "low severity",
};

const ONE_LEVEL_LOWER: Readonly<Record<PriorityLevel, PriorityLevel>> = {
  urgent: "high",
  high: "normal",
  normal: "low",
  low: "low",
};

/** What the rows test, worked out once from the facts and the threshold. */
interface Signals {
  readonly facts: CveFacts;
  readonly severity: NvdSeverity | null;
  readonly epssHigh: boolean;
  readonly epssReasons: readonly string[]; // the EPSS reason when EPSS is high, else none
}

type PriorityRow = readonly [
  row: number,
  when: (s: Signals) => boolean,
  level: PriorityLevel,
  why: (s: Signals) => string[],
];

const severityIs =
  (sev: NvdSeverity) =>
  (s: Signals): boolean =>
    s.severity === sev;
const row1Reasons = (s: Signals): string[] => [
  "in KEV",
  ...s.epssReasons,
  ...(s.facts.internet_facing ? ["internet-facing"] : []),
];
const row2Reasons = (s: Signals): string[] => [
  ...(s.severity === "CRITICAL" ? ["critical"] : []),
  ...s.epssReasons,
  "internet-facing",
];
const severityReason = (s: Signals): string[] => [
  s.severity ? SEVERITY_REASON[s.severity] : "not scored yet",
];

// The priority table. Read top to bottom; the first match wins.
const PRIORITY_TABLE: readonly PriorityRow[] = [
  [1, (s) => s.facts.kev && s.facts.verdict !== "not_affected", "urgent", row1Reasons],
  [
    2,
    (s) => s.facts.internet_facing && (s.severity === "CRITICAL" || s.epssHigh),
    "high",
    row2Reasons,
  ],
  [3, severityIs("CRITICAL"), "high", severityReason],
  [4, severityIs("HIGH"), "normal", severityReason],
  [5, severityIs("MEDIUM"), "normal", severityReason],
  [6, severityIs("LOW"), "low", severityReason],
  [7, (s) => s.severity === null, "normal", severityReason],
];

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10];
  return `${n}${suffix ?? "th"}`;
}

/** 0.9 -> 90, not 89.99999. Python: int(round(p * 100, 6)). */
function percent(p: number): number {
  return Math.trunc(Number((p * 100).toFixed(6)));
}

/** The UTC calendar day `date` falls on, as YYYY-MM-DD. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD, so that comparing two as text compares the days. */
function isoDate(date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d.getTime()) || utcDay(d) !== date) {
    throw new RangeError(`Invalid isoformat string: '${date}'`);
  }
  return d;
}

function addDays(date: string, days: number): string {
  const d = isoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
}

/** An Accepted Finding whose review date has come. No review date counts as due. */
function reviewDue(status: Status, reviewDate: string | null, asOf: string): boolean {
  return status === "accepted" && (reviewDate === null || asOf >= reviewDate);
}

/** Open, or Accepted with its review date come: the spike's `isOpen`. */
function isOpen(status: Status, reviewDate: string | null, asOf: string): boolean {
  return status === "open" || reviewDue(status, reviewDate, asOf);
}

/**
 * The level, reasons, due date and overdue for one CVE. `epssPercentile`: row 2's threshold. Throws a RangeError for
 * a date that isn't YYYY-MM-DD, every date given checked up front, whichever one the due date is counted from, or an
 * EPSS percentile outside 0 to 1.
 */
export function priority(
  facts: CveFacts,
  policy: PriorityPolicy,
  asOf: string,
  epssPercentile = 90,
): Priority {
  for (const date of [asOf, facts.published]) isoDate(date);
  for (const date of [facts.kev_added, facts.kev_deadline, facts.review_date]) {
    if (date) isoDate(date);
  }
  const epss = facts.epss_percentile;
  if (epss !== null && !(epss >= 0 && epss <= 1)) {
    throw new RangeError(`EPSS percentile must be from 0 to 1, got ${epss}`);
  }
  const pct = epss !== null ? percent(epss) : null;
  const epssHigh = pct !== null && pct >= epssPercentile;
  const s: Signals = {
    facts,
    severity: isNvdSeverity(facts.severity) ? facts.severity : null,
    epssHigh,
    epssReasons: epssHigh ? [`EPSS ${ordinal(pct)} percentile`] : [],
  };
  const match = PRIORITY_TABLE.find((r) => r[1](s));
  if (!match) throw new Error("no priority row matched"); // row 7 catches every unscored CVE
  const [row, , matched, why] = match;
  let level = matched;
  const reasons = why(s);

  if (facts.verdict === "not_affected") {
    if (level === "low") {
      reasons.push("not affected: low stays low");
    } else {
      level = ONE_LEVEL_LOWER[level];
      reasons.push((facts.kev ? "in KEV, but not affected" : "not affected") + ": one level lower");
    }
  }

  let due: string;
  let dueFrom: string;
  if (facts.kev && policy.adopt_kev_deadline && facts.kev_deadline) {
    due = facts.kev_deadline;
    dueFrom = "KEV deadline";
  } else {
    const days = policy[`${level}_days`];
    const [start, label] =
      facts.kev && facts.kev_added
        ? [facts.kev_added, "added to KEV"]
        : [facts.published, "published"];
    due = addDays(start, days);
    dueFrom = `${label} + ${days} days`;
  }

  const overdue =
    isOpen(facts.status, facts.review_date ?? null, asOf) && !facts.no_fix && asOf > due;
  return {
    level,
    reasons,
    row,
    due_date: due,
    due_from: dueFrom,
    overdue,
    alert_priority: ALERT_PRIORITY[level],
  };
}
