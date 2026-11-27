// "Are we ready for the audit?" and the Audit-ready Level (spec #341, slice 4, stories 8 and 9): the answer's case table
// from each Control's worked-out Verdict and review state, and when a Team is Audit-ready from its Catalogue switches
// and reviews. Pure: no database, no clock.
import { ReviewedVerdict, type ReviewState, type Verdict } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { auditAnswerOf, isAuditReady, type ControlStanding } from "./audit.ts";

const ISA = "vda-isa-2027.1";

/** A Control `ref` of ISA2027 standing at `verdict`, `review_state` and `reviewed_verdict`. */
const control = (
  ref: string,
  verdict: Verdict,
  review_state: ReviewState = "not_reviewed",
  reviewed_verdict: ReviewedVerdict | null = null,
): ControlStanding => ({
  ref,
  question: `Question ${ref}?`,
  verdict,
  review_state,
  reviewed_verdict,
});

/** ISA2027 on, with `controls`. */
const on = (...controls: ControlStanding[]) => [{ catalogue: ISA, controls }] as const;

describe("auditAnswerOf", () => {
  it("answers no_catalogue, with no counts and no rows, when no Catalogue is on", () => {
    expect(auditAnswerOf([])).toEqual({
      answer: "no_catalogue",
      gaps: 0,
      waiting: 0,
      controls: [],
    });
  });

  it("answers not_yet with every Control waiting when one is on and none is reviewed, a row each in order", () => {
    const answer = auditAnswerOf(
      on(control("1.3.3", "evidenced"), control("4.1.3", "partly_evidenced")),
    );

    expect(answer).toEqual({
      answer: "not_yet",
      gaps: 0,
      waiting: 2,
      controls: [
        {
          catalogue: ISA,
          ref: "1.3.3",
          question: "Question 1.3.3?",
          verdict: "evidenced",
          review_state: "not_reviewed",
          reviewed_verdict: null,
          gap: false,
        },
        {
          catalogue: ISA,
          ref: "4.1.3",
          question: "Question 4.1.3?",
          verdict: "partly_evidenced",
          review_state: "not_reviewed",
          reviewed_verdict: null,
          gap: false,
        },
      ],
    });
  });

  it.each<[ReviewedVerdict, boolean]>([
    ["not_evidenced", true],
    ["partly_evidenced", true],
    ["evidenced", false],
    ["not_applicable", false],
  ])("reads a Control reviewed as %s a Gap: %s", (reviewed, gap) => {
    const answer = auditAnswerOf(on(control("4.1.3", "not_evidenced", "reviewed", reviewed)));

    expect(answer.controls[0]?.gap).toBe(gap);
    expect(answer).toMatchObject({
      answer: gap ? "not_yet" : "yes",
      gaps: gap ? 1 : 0,
      waiting: 0,
    });
  });

  it("reads a Control changed since review as waiting, never a Gap, so the answer is not_yet", () => {
    const answer = auditAnswerOf(
      on(
        control("1.3.3", "evidenced", "reviewed", "evidenced"),
        control("4.1.3", "partly_evidenced", "changed_since_review"),
      ),
    );

    expect(answer).toMatchObject({ answer: "not_yet", gaps: 0, waiting: 1 });
    expect(answer.controls.map(({ gap }) => gap)).toEqual([false, false]);
  });

  it("answers yes when every Control is reviewed with no Gap", () => {
    const answer = auditAnswerOf(
      on(
        control("1.3.3", "evidenced", "reviewed", "evidenced"),
        control("1.3.4", "not_evidenced", "reviewed", "evidenced"),
        control("5.2.4", "not_evidenced", "reviewed", "not_applicable"),
      ),
    );

    expect(answer).toMatchObject({ answer: "yes", gaps: 0, waiting: 0 });
    expect(answer.controls).toHaveLength(3);
  });

  it("counts Gaps and waiting Controls together, a Gap and a waiting one giving not_yet", () => {
    const answer = auditAnswerOf(
      on(
        control("1.3.3", "evidenced", "not_reviewed"),
        control("4.1.3", "partly_evidenced", "reviewed", "partly_evidenced"),
        control("5.2.4", "not_evidenced", "reviewed", "not_evidenced"),
      ),
    );

    expect(answer).toMatchObject({ answer: "not_yet", gaps: 2, waiting: 1 });
  });

  it("answers not_yet, never yes, when the Catalogue on judges no Control", () => {
    expect(auditAnswerOf(on())).toEqual({ answer: "not_yet", gaps: 0, waiting: 0, controls: [] });
  });
});

/** ISA2027's four judged Controls. */
const JUDGED = ["1.3.3", "1.3.4", "4.1.3", "5.2.4"];

describe("isAuditReady", () => {
  it("is false when no Catalogue is on", () => {
    expect(isAuditReady([])).toBe(false);
  });

  it("is false when one is on with one Control unreviewed", () => {
    expect(isAuditReady([{ on: true, judged: JUDGED, reviewed: JUDGED.slice(0, 3) }])).toBe(false);
  });

  it("is true when one is on with every Control reviewed", () => {
    expect(isAuditReady([{ on: true, judged: JUDGED, reviewed: [...JUDGED].reverse() }])).toBe(
      true,
    );
  });

  it("is false when the Catalogue is off, every Control reviewed", () => {
    expect(isAuditReady([{ on: false, judged: JUDGED, reviewed: JUDGED }])).toBe(false);
  });

  it("is false when a second Catalogue on has a Control unreviewed", () => {
    expect(
      isAuditReady([
        { on: true, judged: JUDGED, reviewed: JUDGED },
        { on: true, judged: ["1.1"], reviewed: [] },
      ]),
    ).toBe(false);
  });

  it("is false when the Catalogue on judges no Control", () => {
    expect(isAuditReady([{ on: true, judged: [], reviewed: [] }])).toBe(false);
  });

  it("ignores a Catalogue that is off, when the one on is fully reviewed", () => {
    expect(
      isAuditReady([
        { on: true, judged: JUDGED, reviewed: JUDGED },
        { on: false, judged: ["1.1"], reviewed: [] },
      ]),
    ).toBe(true);
  });
});
