// Patch's priority (A16): how urgent an open CVE is for a Team, with the reasons and a due date. A pure function,
// ported from the spike `architecture/spikes/stack-ts/patch-p3` (src/priority.ts, status.ts, settings.ts), itself a
// port of Patch's backend/app/priority.py. Same names and behaviour; the policy is fixed in code (no Team setting).
import type { Status } from "@warden/contracts";

export type Level = "urgent" | "high" | "normal" | "low";

export const LEVELS: readonly Level[] = ["urgent", "high", "normal", "low"]; // most urgent first: the sort order
export const ALERT_PRIORITY: Readonly<Record<Level, number>> = {
  urgent: 5,
  high: 4,
  normal: 3,
  low: 2,
};

/** Days to fix at each level, and whether a KEV entry's own deadline replaces them. */
export interface PolicySettings {
  readonly urgent_days: number;
  readonly high_days: number;
  readonly normal_days: number;
  readonly low_days: number;
  readonly adopt_kev_deadline: boolean;
}

/** Patch's default policy, the one Warden uses: no Team edits it (spec #101). */
export const PATCH_POLICY: PolicySettings = Object.freeze({
  urgent_days: 7,
  high_days: 30,
  normal_days: 90,
  low_days: 180,
  adopt_kev_deadline: true,
});

export interface CveFacts {
  readonly severity: string | null; // NVD's CRITICAL, HIGH, MEDIUM, LOW; null or NONE when NVD hasn't scored it
  readonly kev: boolean;
  readonly epss_percentile: number | null; // 0-1, EPSS by FIRST
  readonly verdict: string; // affected, not_affected, unknown (A15)
  readonly internet_facing: boolean;
  readonly status: Status;
  readonly published: string; // YYYY-MM-DD
  readonly kev_added?: string | null;
  readonly kev_deadline?: string | null;
  readonly review_date?: string | null; // an Accepted Finding's expiry
  readonly no_fix?: boolean;
}

export interface Priority {
  readonly level: Level;
  readonly reasons: readonly string[];
  readonly rule: number; // the table row that matched
  readonly due_date: string;
  readonly due_from: string; // "KEV deadline", "published + 90 days", "added to KEV + 7 days"
  readonly overdue: boolean;
  readonly alert_priority: number;
}

type NvdSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
const SEVERITY_REASON: Readonly<Record<NvdSeverity, string>> = {
  CRITICAL: "critical",
  HIGH: "high severity",
  MEDIUM: "medium severity",
  LOW: "low severity",
};
const isNvdSeverity = (s: string | null): s is NvdSeverity =>
  s !== null && Object.hasOwn(SEVERITY_REASON, s);

const ONE_LEVEL_LOWER: Readonly<Record<Level, Level>> = {
  urgent: "high",
  high: "normal",
  normal: "low",
  low: "low",
};

/** What the rows test, worked out once from the facts and the threshold. */
interface Signals {
  readonly f: CveFacts;
  readonly severity: NvdSeverity | null;
  readonly epssHigh: boolean;
  readonly epssReasons: readonly string[]; // the EPSS reason when EPSS is high, else none
}

type Rule = readonly [
  row: number,
  when: (s: Signals) => boolean,
  level: Level,
  why: (s: Signals) => string[],
];

const severityIs =
  (sev: NvdSeverity) =>
  (s: Signals): boolean =>
    s.severity === sev;
const row1Reasons = (s: Signals): string[] => [
  "in KEV",
  ...s.epssReasons,
  ...(s.f.internet_facing ? ["internet-facing"] : []),
];
const row2Reasons = (s: Signals): string[] => [
  ...(s.severity === "CRITICAL" ? ["critical"] : []),
  ...s.epssReasons,
  "internet-facing",
];
const severityReason = (s: Signals): string[] => [
  s.severity ? SEVERITY_REASON[s.severity] : "not scored yet",
];

// The rule table. Read top to bottom; the first match wins.
const RULES: readonly Rule[] = [
  [1, (s) => s.f.kev && s.f.verdict !== "not_affected", "urgent", row1Reasons],
  [2, (s) => s.f.internet_facing && (s.severity === "CRITICAL" || s.epssHigh), "high", row2Reasons],
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

function addDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new RangeError(`Invalid isoformat string: '${date}'`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid isoformat string: '${date}'`);
  }
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An Accepted Finding whose review date has come. No review date counts as due. */
function reviewDue(status: Status, reviewDate: string | null, asOf: string): boolean {
  return status === "accepted" && (reviewDate === null || asOf >= reviewDate);
}

/** Open, or Accepted with its review date come: the spike's `isOpen`. */
function isOpen(status: Status, reviewDate: string | null, asOf: string): boolean {
  return status === "open" || reviewDue(status, reviewDate, asOf);
}

/** The level, reasons, due date and overdue for one CVE. `epssPercentile`: row 2's threshold. */
export function priority(
  f: CveFacts,
  policy: PolicySettings,
  asOf: string,
  epssPercentile = 90,
): Priority {
  const pct = f.epss_percentile !== null ? percent(f.epss_percentile) : null;
  const epssHigh = pct !== null && pct >= epssPercentile;
  const s: Signals = {
    f,
    severity: isNvdSeverity(f.severity) ? f.severity : null,
    epssHigh,
    epssReasons: epssHigh && pct ? [`EPSS ${ordinal(pct)} percentile`] : [],
  };
  const match = RULES.find((r) => r[1](s));
  if (!match) throw new Error("no priority rule matched"); // row 7 catches every unscored CVE
  const [row, , matched, why] = match;
  let level = matched;
  const reasons = why(s);

  if (f.verdict === "not_affected") {
    if (level === "low") {
      reasons.push("not affected: low stays low");
    } else {
      level = ONE_LEVEL_LOWER[level];
      reasons.push((f.kev ? "in KEV, but not affected" : "not affected") + ": one level lower");
    }
  }

  let due: string;
  let dueFrom: string;
  if (f.kev && policy.adopt_kev_deadline && f.kev_deadline) {
    due = f.kev_deadline;
    dueFrom = "KEV deadline";
  } else {
    const days = policy[`${level}_days`];
    const [start, label] =
      f.kev && f.kev_added ? [f.kev_added, "added to KEV"] : [f.published, "published"];
    due = addDays(start, days);
    dueFrom = `${label} + ${days} days`;
  }

  const overdue = isOpen(f.status, f.review_date ?? null, asOf) && !f.no_fix && asOf > due;
  return {
    level,
    reasons,
    rule: row,
    due_date: due,
    due_from: dueFrom,
    overdue,
    alert_priority: ALERT_PRIORITY[level],
  };
}

/** Most urgent level first; inside a level, the earliest due date first. */
export function sortKey(level: Level, dueDate: string): [number, string] {
  return [LEVELS.indexOf(level), dueDate];
}
