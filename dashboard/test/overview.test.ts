// The Overview's rules below the page (story 10, spec #341's stories 8 and 9, and spec #225's story 12): each journey
// card's state from the Team's Level, Quick's bar and next step from its latest Scan, Standard's from the hook and the
// Judge, Audit-ready's from the Controls with a review, the trend line's four wordings, and the audit answer's line,
// its rows by Catalogue and the Verdict each row shows.
import type { AgentSessionActivity, CatalogueId, OverviewBody } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import {
  auditAnswerLine,
  controlInAddress,
  controlsByCatalogue,
  focusedControl,
  journeyCards,
  rowAgrees,
  searchWithControl,
  shownVerdict,
  trendLine,
} from "../src/overview.ts";
import {
  auditRow,
  controlDetail,
  ISA,
  isaOn,
  ISA_REFS,
  NO_CATALOGUE,
  reviewedRow,
} from "./audit-fixture.ts";

const SCANNED = "2026-11-24T09:14:00Z";
const scannedOn = new Date(SCANNED).toLocaleDateString(undefined, { dateStyle: "medium" });

/** The Overview's Agent session counts over its 30 days, as the Standard card reads them. */
const sessions = (
  hook_active: boolean,
  judged = 0,
  needs_human_review = 0,
): Pick<OverviewBody, "agent_sessions" | "period_days"> => ({
  agent_sessions: { hook_active, judged, needs_human_review } satisfies AgentSessionActivity,
  period_days: 30,
});

/** No hook event and no session judged in the period. */
const NO_SESSIONS = sessions(false);
/** The hook sending, and 3 sessions judged in the period: Standard's two parts hold. */
const JUDGED = sessions(true, 3);

describe("journeyCards", () => {
  it("at Quick: Quick current, then Standard and Audit-ready not started", () => {
    expect(
      journeyCards("quick", SCANNED, NO_CATALOGUE, NO_SESSIONS).map((card) => [
        card.word,
        card.state,
      ]),
    ).toEqual([
      ["Quick", "current"],
      ["Standard", "not-started"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("at Standard: Quick done, Standard current, Audit-ready not started", () => {
    expect(
      journeyCards("standard", SCANNED, NO_CATALOGUE, JUDGED).map((card) => [
        card.word,
        card.state,
      ]),
    ).toEqual([
      ["Quick", "done"],
      ["Standard", "current"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("says what each Level adds", () => {
    expect(journeyCards("quick", null, NO_CATALOGUE, NO_SESSIONS).map((card) => card.adds)).toEqual(
      ["Repo scan and top fixes", "Agent hook and the Judge", "Evidence for an audit"],
    );
  });

  it("before the first Scan, Quick's bar is empty and its next step is the first Scan", () => {
    const [quick] = journeyCards("quick", null, NO_CATALOGUE, NO_SESSIONS);
    expect(quick).toMatchObject({ progress: 0, notes: ["Next: the first Scan"] });
  });

  it("after a Scan, Quick's bar is full, with the Scan's date and Standard as the next step", () => {
    const [quick] = journeyCards("quick", SCANNED, NO_CATALOGUE, NO_SESSIONS);
    expect(quick).toMatchObject({
      progress: 100,
      notes: [`Last Scan: ${scannedOn}`, "Next: Standard adds the agent hook and the Judge"],
    });
  });

  it("gives a done Level a full bar, and a Level not started an empty one", () => {
    const [quick, , auditReady] = journeyCards("standard", SCANNED, NO_CATALOGUE, JUDGED);
    expect(quick!.progress).toBe(100);
    expect(auditReady!.progress).toBe(0);
  });

  it("at Standard with no Scan, Quick is not started, its bar empty, its next step the first Scan", () => {
    const [quick] = journeyCards("standard", null, NO_CATALOGUE, JUDGED);
    expect(quick).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: the first Scan"],
    });
  });
});

describe("the Standard card (story 12)", () => {
  const standardAt = (
    level: OverviewBody["level"],
    counts: Pick<OverviewBody, "agent_sessions" | "period_days">,
  ) => journeyCards(level, SCANNED, NO_CATALOGUE, counts)[1]!;

  it("at Quick with no hook event in 30 days: not started, an empty bar, an Admin turning on the hook next", () => {
    expect(standardAt("quick", NO_SESSIONS)).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: an Admin turns on the agent hook on Setup"],
    });
  });

  it("at Quick with the hook sending and no session judged: not started, half a bar, the Judge's first session next", () => {
    expect(standardAt("quick", sessions(true))).toMatchObject({
      state: "not-started",
      progress: 50,
      notes: ["Next: the Judge reads the first ended session"],
    });
  });

  it("at Quick with sessions judged but no hook event in 30 days: half a bar, the hook first", () => {
    expect(standardAt("quick", sessions(false, 2))).toMatchObject({
      state: "not-started",
      progress: 50,
      notes: ["Next: an Admin turns on the agent hook on Setup"],
    });
  });

  it("at Standard: current, a full bar, and the sessions judged, in the singular for one", () => {
    expect(standardAt("standard", sessions(true, 1))).toMatchObject({
      state: "current",
      progress: 100,
      notes: ["1 session judged in 30 days"],
    });
    expect(standardAt("standard", sessions(true, 12))).toMatchObject({
      notes: ["12 sessions judged in 30 days"],
    });
  });

  it("names the sessions that need human review: 1 needs, 2 need", () => {
    expect(standardAt("standard", sessions(true, 3, 1)).notes).toEqual([
      "3 sessions judged in 30 days, 1 needs human review",
    ]);
    expect(standardAt("standard", sessions(true, 12, 2)).notes).toEqual([
      "12 sessions judged in 30 days, 2 need human review",
    ]);
  });

  it("says the period the server counted over", () => {
    expect(standardAt("standard", { ...sessions(true, 1), period_days: 7 }).notes).toEqual([
      "1 session judged in 7 days",
    ]);
  });

  it("never says Warden doesn't check it", () => {
    const counts = [NO_SESSIONS, sessions(true), sessions(false, 2), JUDGED, sessions(true, 3, 1)];
    for (const level of ["quick", "standard", "audit_ready"] as const) {
      for (const count of counts) {
        expect(standardAt(level, count).notes).not.toContain("Warden doesn't check this yet.");
      }
    }
  });
});

/** Every one of ISA2027's Controls reviewed: Audit-ready. */
const allReviewed = isaOn({
  answer: "yes",
  waiting: 0,
  controls: ISA_REFS.map((ref) => reviewedRow(ref)),
});

describe("journeyCards at Audit-ready", () => {
  const [quick, standard, auditReady] = journeyCards("audit_ready", SCANNED, allReviewed, JUDGED);

  it("gives Quick Done, with a full bar", () => {
    expect(quick).toMatchObject({ state: "done", progress: 100, notes: [] });
  });

  it("gives Standard Done, a full bar, and the sessions judged, while both its parts hold", () => {
    expect(standard).toMatchObject({
      state: "done",
      progress: 100,
      notes: ["3 sessions judged in 30 days"],
    });
  });

  it("gives Standard Not started with its parts' bar while one part doesn't hold, as the Level passes it without", () => {
    expect(journeyCards("audit_ready", SCANNED, allReviewed, sessions(true))[1]).toMatchObject({
      state: "not-started",
      progress: 50,
      notes: ["Next: the Judge reads the first ended session"],
    });
    expect(journeyCards("audit_ready", SCANNED, allReviewed, NO_SESSIONS)[1]).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: an Admin turns on the agent hook on Setup"],
    });
  });

  it("gives Audit-ready Current, a full bar, and the Controls with a review", () => {
    expect(auditReady).toMatchObject({
      state: "current",
      progress: 100,
      notes: ["4 of 4 Controls have a review"],
    });
  });

  it("with no Scan, gives Quick Not started and the first Scan as its next step, Standard and Audit-ready as with one", () => {
    const [noScanQuick, noScanStandard, noScanAuditReady] = journeyCards(
      "audit_ready",
      null,
      allReviewed,
      JUDGED,
    );
    expect(noScanQuick).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: the first Scan"],
    });
    expect(noScanStandard).toEqual(standard);
    expect(noScanAuditReady).toEqual(auditReady);
  });

  it("names the Controls changed since review, which the answer counts as waiting", () => {
    const audit = isaOn({
      answer: "not_yet",
      waiting: 1,
      controls: [
        ...ISA_REFS.slice(0, 3).map((ref) => reviewedRow(ref)),
        auditRow("5.2.4", { review_state: "changed_since_review" }),
      ],
    });
    expect(journeyCards("audit_ready", SCANNED, audit, NO_SESSIONS)[2]).toMatchObject({
      state: "current",
      notes: ["4 of 4 Controls have a review, 1 changed since"],
    });
  });
});

describe("the Audit-ready card before it is reached", () => {
  const auditReadyAtQuick = (audit: OverviewBody["audit"]) =>
    journeyCards("quick", SCANNED, audit, NO_SESSIONS)[2];

  it("with no Catalogue on, its next step is an Admin turning one on", () => {
    expect(auditReadyAtQuick(NO_CATALOGUE)).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: an Admin turns on a Catalogue"],
    });
  });

  it("with ISA2027 on and nothing reviewed, says 0 of 4 Controls have a review", () => {
    expect(auditReadyAtQuick(isaOn())).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["0 of 4 Controls have a review"],
    });
  });

  it("with one Control judged, says it in the singular", () => {
    expect(auditReadyAtQuick(isaOn({ waiting: 1, controls: [auditRow("1.3.3")] }))).toMatchObject({
      notes: ["0 of 1 Control has a review"],
    });
  });

  it("with a Catalogue on that judges no Control, says there are none to review, as the answer line does", () => {
    expect(auditReadyAtQuick(isaOn({ waiting: 0, controls: [] }))).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["No Controls to review"],
    });
  });

  it("counts a Control changed since review as having one, as the Level does, and names it: 3 of 4", () => {
    const audit = isaOn({
      waiting: 2,
      controls: [
        reviewedRow("1.3.3"),
        reviewedRow("1.3.4"),
        auditRow("4.1.3", { review_state: "changed_since_review" }),
        auditRow("5.2.4"),
      ],
    });
    expect(auditReadyAtQuick(audit)).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["3 of 4 Controls have a review, 1 changed since"],
    });
  });
});

describe("shownVerdict", () => {
  it("is the reviewed Verdict while the Control is reviewed", () => {
    expect(
      shownVerdict(
        auditRow("1.3.3", {
          verdict: "evidenced",
          review_state: "reviewed",
          reviewed_verdict: "not_applicable",
        }),
      ),
    ).toBe("not_applicable");
  });

  it.each(["not_reviewed", "changed_since_review"] as const)(
    "is the worked-out Verdict while %s",
    (review_state) => {
      expect(shownVerdict(auditRow("1.3.4", { verdict: "partly_evidenced", review_state }))).toBe(
        "partly_evidenced",
      );
    },
  );

  it("is the worked-out Verdict for a reviewed row with no reviewed Verdict", () => {
    expect(
      shownVerdict(auditRow("4.1.3", { verdict: "evidenced", review_state: "reviewed" })),
    ).toBe("evidenced");
  });
});

describe("controlInAddress", () => {
  it("is the Catalogue and ref the address names", () => {
    expect(controlInAddress("?catalogue=vda-isa-2027.1&control=1.3.3")).toEqual({
      catalogue: "vda-isa-2027.1",
      ref: "1.3.3",
    });
  });

  it.each(["", "?control=1.3.3", "?catalogue=vda-isa-2027.1", "?catalogue=&control=1.3.3"])(
    "is null unless the address names both (%j)",
    (search) => {
      expect(controlInAddress(search)).toBeNull();
    },
  );
});

describe("searchWithControl", () => {
  const focus = { catalogue: "vda-isa-2027.1", ref: "1.3.3" };

  it("writes the Control's Catalogue and ref, keeping the address's other params", () => {
    expect(searchWithControl("?tab=x", focus)).toBe(
      "?tab=x&catalogue=vda-isa-2027.1&control=1.3.3",
    );
  });

  it("rewrites a Control already there in place", () => {
    expect(searchWithControl("?catalogue=other&control=9.9.9&tab=x", focus)).toBe(
      "?catalogue=vda-isa-2027.1&control=1.3.3&tab=x",
    );
  });

  it("drops only the Catalogue and ref with no Control in focus", () => {
    expect(searchWithControl("?catalogue=vda-isa-2027.1&tab=x&control=1.3.3", null)).toBe("?tab=x");
    expect(searchWithControl("?control=1.3.3", null)).toBe("");
  });

  it("gives back the address as it is when it already says so", () => {
    expect(searchWithControl("?control=1.3.3&catalogue=vda-isa-2027.1", focus)).toBe(
      "?control=1.3.3&catalogue=vda-isa-2027.1",
    );
    expect(searchWithControl("?tab=a%20b", null)).toBe("?tab=a%20b");
  });
});

describe("focusedControl", () => {
  const audit = isaOn();

  it("is the Catalogue and row the address names", () => {
    expect(focusedControl(audit, { catalogue: ISA.id, ref: "1.3.4" })).toEqual({
      catalogue: ISA,
      control: audit.controls.find(({ ref }) => ref === "1.3.4"),
    });
  });

  it.each([
    ["no Control", null],
    ["a ref the answer doesn't hold", { catalogue: ISA.id, ref: "9.9.9" }],
    ["a Catalogue the answer doesn't list", { catalogue: "not-on", ref: "1.3.3" }],
  ])("is null for %s", (_, control) => {
    expect(focusedControl(audit, control)).toBeNull();
  });

  it("is null for a row of a Catalogue the answer doesn't list", () => {
    expect(focusedControl(isaOn({ catalogues: [] }), { catalogue: ISA.id, ref: "1.3.3" })).toBe(
      null,
    );
  });
});

describe("rowAgrees", () => {
  const read = controlDetail("1.3.3", {
    verdict: "partly_evidenced",
    review_state: "reviewed",
    reviewed_verdict: "not_applicable",
  });
  const row = auditRow("1.3.3", {
    verdict: "partly_evidenced",
    review_state: "reviewed",
    reviewed_verdict: "not_applicable",
  });

  it("agrees when the row holds the read's Verdicts and review state", () => {
    expect(rowAgrees(row, read)).toBe(true);
  });

  it.each([
    ["the worked-out Verdict", { verdict: "evidenced" }],
    ["the review state", { review_state: "changed_since_review" }],
    ["the reviewed Verdict", { reviewed_verdict: "evidenced" }],
  ] as const)("disagrees on %s", (_, fields) => {
    expect(rowAgrees({ ...row, ...fields }, read)).toBe(false);
  });
});

describe("controlsByCatalogue", () => {
  // Warden has one Catalogue today: the second's id stands for the next one it gets.
  const second = { ...ISA, id: "a-second-catalogue" as CatalogueId, name: "A second Catalogue" };
  const ofSecond = (ref: string) => auditRow(ref, { catalogue: second.id });

  it("gives each listed Catalogue, in the answer's order, its own rows in order", () => {
    const audit = isaOn({
      catalogues: [second, ISA],
      controls: [auditRow("1.3.3"), ofSecond("9.1"), auditRow("1.3.4"), ofSecond("9.2")],
    });
    expect(
      controlsByCatalogue(audit).map(({ catalogue, controls }) => [
        catalogue.name,
        controls.map(({ ref }) => ref),
      ]),
    ).toEqual([
      ["A second Catalogue", ["9.1", "9.2"]],
      ["VDA ISA 2027.1", ["1.3.3", "1.3.4"]],
    ]);
  });

  it("keeps a listed Catalogue with no row, its list empty", () => {
    expect(controlsByCatalogue(isaOn({ controls: [] }))).toEqual([
      { catalogue: ISA, controls: [] },
    ]);
  });

  it("drops the rows of a Catalogue the answer doesn't list", () => {
    expect(controlsByCatalogue(isaOn({ catalogues: [] }))).toEqual([]);
  });
});

describe("auditAnswerLine", () => {
  it("yes, with all 4 Controls reviewed", () => {
    expect(auditAnswerLine(allReviewed)).toBe("Yes: all 4 Controls are reviewed, with no Gaps.");
  });

  it("yes, with the 1 Control reviewed", () => {
    expect(
      auditAnswerLine(isaOn({ answer: "yes", waiting: 0, controls: [reviewedRow("1.3.3")] })),
    ).toBe("Yes: the 1 Control is reviewed, with no Gaps.");
  });

  it.each([
    [2, 1, "Not yet: 2 Gaps, 1 Control waiting for review."],
    [1, 0, "Not yet: 1 Gap."],
    [0, 4, "Not yet: 4 Controls waiting for review."],
    [0, 0, "Not yet: no Controls to review."],
  ])("not yet, with %i Gaps and %i waiting", (gaps, waiting, line) => {
    expect(auditAnswerLine(isaOn({ gaps, waiting }))).toBe(line);
  });

  it("with no Catalogue on, says when Warden can answer", () => {
    expect(auditAnswerLine(NO_CATALOGUE)).toBe(
      "Warden can answer this at Audit-ready, once Vouch checks your Controls.",
    );
  });
});

const body = (fields: Partial<OverviewBody>): OverviewBody => ({
  team: "org_a",
  level: "quick",
  audit: NO_CATALOGUE,
  last_scan_at: SCANNED,
  has_findings: true,
  period_days: 30,
  agent_sessions: { hook_active: false, judged: 0, needs_human_review: 0 },
  open_at_start: 0,
  open_now: 7,
  fix_rate: { fixed: 1, of: 11 },
  ...fields,
});

const nothingCounted = { open_at_start: 0, open_now: 0, fix_rate: { fixed: 0, of: 0 } };

describe("trendLine", () => {
  it("says where Open Findings went, and the fix rate as a whole percent", () => {
    expect(trendLine(body({}))).toBe("Open Findings went from 0 to 7 in 30 days; fix rate 9%.");
  });

  it("says Open Findings stayed when the count didn't change", () => {
    expect(trendLine(body({ open_at_start: 7 }))).toBe(
      "Open Findings stayed at 7 over 30 days; fix rate 9%.",
    );
  });

  it("rounds the rate down, so 199 of 200 is 99%, never a 100% that isn't", () => {
    expect(trendLine(body({ fix_rate: { fixed: 199, of: 200 } }))).toBe(
      "Open Findings went from 0 to 7 in 30 days; fix rate 99%.",
    );
  });

  it("shows at least 1% when any was fixed: 1 of 300 is 1%", () => {
    expect(trendLine(body({ fix_rate: { fixed: 1, of: 300 } }))).toBe(
      "Open Findings went from 0 to 7 in 30 days; fix rate 1%.",
    );
  });

  it("drops the fix rate when nothing was there to fix", () => {
    expect(trendLine(body(nothingCounted))).toBe("Open Findings stayed at 0 over 30 days.");
  });

  it("with Findings that all stay out of the counts (Accepted and old) and no Scan, still gives the trend", () => {
    expect(trendLine(body({ ...nothingCounted, last_scan_at: null }))).toBe(
      "Open Findings stayed at 0 over 30 days.",
    );
  });

  it("with no Findings and no Scan, says the trend starts after the first Scan", () => {
    expect(trendLine(body({ ...nothingCounted, has_findings: false, last_scan_at: null }))).toBe(
      "No Findings yet: the trend starts after the first Scan.",
    );
  });
});
