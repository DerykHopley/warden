// The Overview's rules below the page (story 10, and spec #341's stories 8 and 9): each journey card's state from the
// Team's Level, Quick's bar and next step from its latest Scan, Standard's while Warden has no Standard rule,
// Audit-ready's from the Controls reviewed, the trend line's four wordings, and the audit answer's line.
import type { OverviewBody } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { auditAnswerLine, journeyCards, trendLine } from "../src/overview.ts";
import { auditRow, isaOn, ISA_REFS, NO_CATALOGUE, reviewedRow } from "./audit-fixture.ts";

const SCANNED = "2026-11-24T09:14:00Z";
const scannedOn = new Date(SCANNED).toLocaleDateString(undefined, { dateStyle: "medium" });

describe("journeyCards", () => {
  it("at Quick: Quick current, then Standard and Audit-ready not started", () => {
    expect(
      journeyCards("quick", SCANNED, NO_CATALOGUE).map((card) => [card.word, card.state]),
    ).toEqual([
      ["Quick", "current"],
      ["Standard", "not-started"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("at Standard: Quick done, Standard current, Audit-ready not started", () => {
    expect(
      journeyCards("standard", SCANNED, NO_CATALOGUE).map((card) => [card.word, card.state]),
    ).toEqual([
      ["Quick", "done"],
      ["Standard", "current"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("says what each Level adds", () => {
    expect(journeyCards("quick", null, NO_CATALOGUE).map((card) => card.adds)).toEqual([
      "Repo scan and top fixes",
      "Agent hook and the Judge",
      "Evidence for an audit",
    ]);
  });

  it("before the first Scan, Quick's bar is empty and its next step is the first Scan", () => {
    const [quick] = journeyCards("quick", null, NO_CATALOGUE);
    expect(quick).toMatchObject({ progress: 0, notes: ["Next: the first Scan"] });
  });

  it("after a Scan, Quick's bar is full, with the Scan's date and Standard as the next step", () => {
    const [quick] = journeyCards("quick", SCANNED, NO_CATALOGUE);
    expect(quick).toMatchObject({
      progress: 100,
      notes: [`Last Scan: ${scannedOn}`, "Next: Standard adds the agent hook and the Judge"],
    });
  });

  it("gives a done Level a full bar, and a Level not started an empty one", () => {
    const [quick, standard, auditReady] = journeyCards("standard", SCANNED, NO_CATALOGUE);
    expect(quick!.progress).toBe(100);
    expect(standard!.progress).toBe(0);
    expect(auditReady!.progress).toBe(0);
  });

  it("at Quick and at Standard, the Standard card has no note, its bar empty", () => {
    for (const level of ["quick", "standard"] as const) {
      const [, standard] = journeyCards(level, SCANNED, NO_CATALOGUE);
      expect(standard).toMatchObject({ progress: 0, notes: [] });
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
  const [quick, standard, auditReady] = journeyCards("audit_ready", SCANNED, allReviewed);

  it("gives Quick Done, with a full bar", () => {
    expect(quick).toMatchObject({ state: "done", progress: 100, notes: [] });
  });

  it("never gives Standard Done while Warden has no Standard rule: not started, an empty bar, and why", () => {
    expect(standard).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Warden doesn't check this yet."],
    });
  });

  it("gives Audit-ready Current, a full bar, and the Controls reviewed", () => {
    expect(auditReady).toMatchObject({
      state: "current",
      progress: 100,
      notes: ["4 of 4 Controls reviewed"],
    });
  });
});

describe("the Audit-ready card before it is reached", () => {
  const auditReadyAtQuick = (audit: OverviewBody["audit"]) =>
    journeyCards("quick", SCANNED, audit)[2];

  it("with no Catalogue on, its next step is an Admin turning one on", () => {
    expect(auditReadyAtQuick(NO_CATALOGUE)).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["Next: an Admin turns on a Catalogue"],
    });
  });

  it("with ISA2027 on and nothing reviewed, says 0 of 4 Controls reviewed", () => {
    expect(auditReadyAtQuick(isaOn())).toMatchObject({
      state: "not-started",
      progress: 0,
      notes: ["0 of 4 Controls reviewed"],
    });
  });

  it("counts a Control changed since review as reviewed, as the Level does: 3 of 4", () => {
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
      notes: ["3 of 4 Controls reviewed"],
    });
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
