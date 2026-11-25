// The 47 priority cases from the spike `architecture/spikes/stack-ts/patch-p3` (test/priority.test.ts, itself a port of
// Patch's tests/test_priority.py): same names, same expected values. Check ids: A16.n, A16b.3.
import type { Status } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import {
  ALERT_PRIORITY,
  type CveFacts,
  PATCH_POLICY,
  type PolicySettings,
  priority,
} from "./priority.ts";

const AS_OF = "2026-10-13"; // the snapshot date
const DEFAULT = PATCH_POLICY; // urgent 7, high 30, normal 90, low 180 days; adopt the KEV deadline
const NO_KEV_DEADLINE: PolicySettings = { ...PATCH_POLICY, adopt_kev_deadline: false };

interface FactsGiven {
  severity: string | null;
  kev: boolean;
  epss: number | null;
  verdict: string;
  internet_facing: boolean;
  status: Status;
  published: string;
  kev_added: string | null;
  kev_deadline: string | null;
  review_date: string | null;
  no_fix: boolean;
}

/** Python's facts(**kwargs) with defaults; snake_case keys so rows read like the Python ones. */
function facts(given: Partial<FactsGiven> = {}): CveFacts {
  const a: FactsGiven = {
    severity: "HIGH",
    kev: false,
    epss: null,
    verdict: "unknown",
    internet_facing: false,
    status: "open",
    published: "2026-10-01",
    kev_added: null,
    kev_deadline: null,
    review_date: null,
    no_fix: false,
    ...given,
  };
  return {
    severity: a.severity,
    kev: a.kev,
    epss_percentile: a.epss,
    verdict: a.verdict,
    internet_facing: a.internet_facing,
    status: a.status,
    published: a.published,
    kev_added: a.kev_added,
    kev_deadline: a.kev_deadline,
    review_date: a.review_date,
    no_fix: a.no_fix,
  };
}

const KEV = { kev: true, kev_added: "2025-05-05", kev_deadline: "2025-05-26" }; // CVE-2025-3248's dates

// --- A16.1: every row of the rule table, and the step-down -----------------------------------------------------

const LEVELS: [string, CveFacts, string, string[]][] = [
  ["1: in KEV, affected", facts({ verdict: "affected", ...KEV }), "urgent", ["in KEV"]],
  [
    "1: in KEV, verdict unknown, low severity",
    facts({ severity: "LOW", ...KEV }),
    "urgent",
    ["in KEV"],
  ],
  [
    "1: in KEV with every other signal",
    facts({ epss: 0.98592, internet_facing: true, ...KEV }),
    "urgent",
    ["in KEV", "EPSS 98th percentile", "internet-facing"],
  ],
  [
    "2: critical, internet-facing",
    facts({ severity: "CRITICAL", epss: 0.4, internet_facing: true }),
    "high",
    ["critical", "internet-facing"],
  ],
  [
    "2: medium with high EPSS, internet-facing",
    facts({ severity: "MEDIUM", epss: 0.95, internet_facing: true }),
    "high",
    ["EPSS 95th percentile", "internet-facing"],
  ],
  [
    "2: critical and high EPSS, internet-facing",
    facts({ severity: "CRITICAL", epss: 0.99, internet_facing: true }),
    "high",
    ["critical", "EPSS 99th percentile", "internet-facing"],
  ],
  [
    "2: EPSS exactly at the threshold counts",
    facts({ severity: "LOW", epss: 0.9, internet_facing: true }),
    "high",
    ["EPSS 90th percentile", "internet-facing"],
  ],
  [
    "2: EPSS just under the threshold doesn't",
    facts({ severity: "MEDIUM", epss: 0.89931, internet_facing: true }),
    "normal",
    ["medium severity"],
  ],
  [
    "2: high EPSS but not internet-facing",
    facts({ severity: "MEDIUM", epss: 0.99 }),
    "normal",
    ["medium severity"],
  ],
  ["3: critical, not internet-facing", facts({ severity: "CRITICAL" }), "high", ["critical"]],
  ["4: high severity", facts({ severity: "HIGH" }), "normal", ["high severity"]],
  [
    "4: high severity, internet-facing, low EPSS",
    facts({ severity: "HIGH", epss: 0.5, internet_facing: true }),
    "normal",
    ["high severity"],
  ],
  ["5: medium severity", facts({ severity: "MEDIUM" }), "normal", ["medium severity"]],
  ["6: low severity", facts({ severity: "LOW" }), "low", ["low severity"]],
  ["unscored (no severity)", facts({ severity: null }), "normal", ["not scored yet"]],
  ["unscored (NVD's NONE)", facts({ severity: "NONE" }), "normal", ["not scored yet"]],
  [
    "step: critical internet-facing, not affected",
    facts({ severity: "CRITICAL", internet_facing: true, verdict: "not_affected" }),
    "normal",
    ["critical", "internet-facing", "not affected: one level lower"],
  ],
  [
    "step: critical, not affected",
    facts({ severity: "CRITICAL", verdict: "not_affected" }),
    "normal",
    ["critical", "not affected: one level lower"],
  ],
  [
    "step: high, not affected",
    facts({ severity: "HIGH", verdict: "not_affected" }),
    "low",
    ["high severity", "not affected: one level lower"],
  ],
  [
    "step: medium, not affected",
    facts({ severity: "MEDIUM", verdict: "not_affected" }),
    "low",
    ["medium severity", "not affected: one level lower"],
  ],
  [
    "step: low stays low",
    facts({ severity: "LOW", verdict: "not_affected" }),
    "low",
    ["low severity", "not affected: low stays low"],
  ],
  [
    "step: affected changes nothing",
    facts({ severity: "HIGH", verdict: "affected" }),
    "normal",
    ["high severity"],
  ],
  [
    "step: KEV, not affected, high",
    facts({ severity: "HIGH", verdict: "not_affected", ...KEV }),
    "low",
    ["high severity", "in KEV, but not affected: one level lower"],
  ],
  [
    "step: KEV, not affected, critical internet-facing",
    facts({ severity: "CRITICAL", internet_facing: true, verdict: "not_affected", ...KEV }),
    "normal",
    ["critical", "internet-facing", "in KEV, but not affected: one level lower"],
  ],
];

describe("test_a16_1_rule_table", () => {
  it.each(LEVELS)("%s", (_case, f, level, reasons) => {
    const p = priority(f, DEFAULT, AS_OF);
    expect([p.level, [...p.reasons]]).toEqual([level, reasons]);
  });
});

it("test_a16_1_the_epss_threshold_is_a_setting", () => {
  const f = facts({ severity: "MEDIUM", epss: 0.93, internet_facing: true });
  expect(priority(f, DEFAULT, AS_OF).level).toBe("high");
  expect(priority(f, DEFAULT, AS_OF, 95).level).toBe("normal");
});

it("test_a16_1_the_rule_that_matched_is_named", () => {
  expect(priority(facts(KEV), DEFAULT, AS_OF).rule).toBe(1);
  expect(
    priority(facts({ severity: "CRITICAL", internet_facing: true }), DEFAULT, AS_OF).rule,
  ).toBe(2);
  expect(priority(facts({ severity: "LOW" }), DEFAULT, AS_OF).rule).toBe(6);
  expect(
    priority(facts({ severity: "HIGH", verdict: "not_affected", ...KEV }), DEFAULT, AS_OF).rule,
  ).toBe(4);
});

// --- A16.2: levels map to alert priorities 5/4/3/2 -------------------------------------------------------------

it("test_a16_2_levels_map_to_alert_priorities", () => {
  expect(ALERT_PRIORITY).toEqual({ urgent: 5, high: 4, normal: 3, low: 2 });
  expect(priority(facts(KEV), DEFAULT, AS_OF).alert_priority).toBe(5);
  expect(priority(facts({ severity: "LOW" }), DEFAULT, AS_OF).alert_priority).toBe(2);
});

// --- A16.3: due dates from the policy, the KEV deadline when adopted, overdue at the as-of date ----------------

const DUE: [string, CveFacts, PolicySettings, string, boolean][] = [
  [
    "high: published + 30",
    facts({ severity: "CRITICAL", published: "2026-10-01" }),
    DEFAULT,
    "2026-10-31",
    false,
  ],
  [
    "normal: published + 90",
    facts({ severity: "MEDIUM", published: "2026-01-01" }),
    DEFAULT,
    "2026-04-01",
    true,
  ],
  [
    "low: published + 180",
    facts({ severity: "LOW", published: "2026-05-01" }),
    DEFAULT,
    "2026-10-28",
    false,
  ],
  [
    "the stepped-down level's days",
    facts({ severity: "CRITICAL", verdict: "not_affected", published: "2026-01-01" }),
    DEFAULT,
    "2026-04-01",
    true,
  ],
  [
    "custom days",
    facts({ severity: "CRITICAL", published: "2026-10-01" }),
    { ...PATCH_POLICY, high_days: 14 },
    "2026-10-15",
    false,
  ],
  ["KEV, deadline adopted", facts(KEV), DEFAULT, "2025-05-26", true],
  ["KEV, not adopted: KEV-added + 7", facts(KEV), NO_KEV_DEADLINE, "2025-05-12", true],
  [
    "KEV not affected, not adopted: KEV-added + 90",
    facts({ severity: "CRITICAL", verdict: "not_affected", ...KEV }),
    NO_KEV_DEADLINE,
    "2025-08-03",
    true,
  ],
  [
    "KEV not affected, adopted: still the KEV deadline",
    facts({ severity: "CRITICAL", verdict: "not_affected", ...KEV }),
    DEFAULT,
    "2025-05-26",
    true,
  ],
  [
    "due on the as-of date isn't overdue yet",
    facts({ severity: "CRITICAL", published: "2026-09-13" }),
    DEFAULT,
    "2026-10-13",
    false,
  ],
  [
    "due the day before is overdue",
    facts({ severity: "CRITICAL", published: "2026-09-12" }),
    DEFAULT,
    "2026-10-12",
    true,
  ],
  [
    "fixed is never overdue",
    facts({ severity: "MEDIUM", published: "2024-01-01", status: "fixed" }),
    DEFAULT,
    "2024-03-31",
    false,
  ],
  // The spike's status here was Patch's `not_affected` mark. Warden has no such Status: "not affected" is an Accept
  // with that reason (GLOSSARY Accepted), and the mark that never counts as open is False positive.
  [
    "not affected (your mark) is never overdue",
    facts({ severity: "MEDIUM", published: "2024-01-01", status: "false_positive" }),
    DEFAULT,
    "2024-03-31",
    false,
  ],
];

describe("test_a16_3_due_date_and_overdue", () => {
  it.each(DUE)("%s", (_case, f, policy, due, overdue) => {
    const p = priority(f, policy, AS_OF);
    expect([p.due_date, p.overdue]).toEqual([due, overdue]);
  });
});

// --- A16b.3: overdue only when a fix exists and the CVE is open ------------------------------------------------

const OVERDUE: [string, CveFacts, boolean][] = [
  ["open, a fix exists, past due", facts({ severity: "MEDIUM", published: "2024-01-01" }), true],
  [
    "open, no fix yet, past due: not overdue",
    facts({ severity: "MEDIUM", published: "2024-01-01", no_fix: true }),
    false,
  ],
  [
    "accepted before its review date",
    facts({
      severity: "MEDIUM",
      published: "2024-01-01",
      status: "accepted",
      review_date: "2027-01-01",
    }),
    false,
  ],
  [
    "accepted, review due, a fix exists",
    facts({
      severity: "MEDIUM",
      published: "2024-01-01",
      status: "accepted",
      review_date: "2026-10-13",
    }),
    true,
  ],
  [
    "accepted, review due, no fix yet",
    facts({
      severity: "MEDIUM",
      published: "2024-01-01",
      status: "accepted",
      review_date: "2026-10-01",
      no_fix: true,
    }),
    false,
  ],
  ["KEV, no fix yet: not overdue either", facts({ no_fix: true, ...KEV }), false],
];

describe("test_a16b_3_overdue_only_when_a_fix_exists", () => {
  it.each(OVERDUE)("%s", (_case, f, overdue) => {
    const p = priority(f, DEFAULT, AS_OF);
    expect(p.overdue).toBe(overdue);
    expect(p.due_date).toBeTruthy(); // a no-fix CVE keeps its due date: the "decide by" date
  });
});

it("test_a16_3_the_due_date_says_where_it_came_from", () => {
  expect(priority(facts(KEV), DEFAULT, AS_OF).due_from).toBe("KEV deadline");
  expect(priority(facts(KEV), NO_KEV_DEADLINE, AS_OF).due_from).toBe("added to KEV + 7 days");
  expect(priority(facts({ severity: "LOW" }), DEFAULT, AS_OF).due_from).toBe(
    "published + 180 days",
  );
});

// --- Warden's own: an Accepted Finding's expiry is its review date, and bad dates are refused ------------------

describe("overdue with Warden's Status", () => {
  const pastDue = { severity: "MEDIUM", published: "2024-01-01" } as const;

  it.each([
    [
      "Accepted, its expiry passed",
      facts({ ...pastDue, status: "accepted", review_date: "2026-10-12" }),
      true,
    ],
    [
      "Accepted, its expiry a day ahead",
      facts({ ...pastDue, status: "accepted", review_date: "2026-10-14" }),
      false,
    ],
    [
      "Fixed, even with an expiry passed",
      facts({ ...pastDue, status: "fixed", review_date: "2026-10-12" }),
      false,
    ],
  ] as const)("%s", (_case, f, overdue) => {
    expect(priority(f, DEFAULT, AS_OF).overdue).toBe(overdue);
  });
});

it("refuses a published date that isn't a real YYYY-MM-DD", () => {
  expect(() => priority(facts({ published: "2026-13-01" }), DEFAULT, AS_OF)).toThrow(RangeError);
});
