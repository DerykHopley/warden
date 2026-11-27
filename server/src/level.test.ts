// The Team's Level from its facts (spec #225, story 12: Standard from the hook and the Judge), and the Audit-ready
// fact the Overview works out from Vouch's answer in hand (spec #341, slice 4, story 9), by the rule Vouch's
// `isAuditReady` reads from its switches and reviews. Pure: no database, no clock.
import type {
  AuditAnswer,
  AuditCatalogue,
  AuditControl,
  CatalogueId,
  ReviewState,
} from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { auditReadyOfAnswer, standardFacts, teamLevel } from "./level.ts";

describe("teamLevel", () => {
  it.each([
    [false, false, "quick"],
    [true, false, "quick"],
    [false, true, "quick"],
    [true, true, "standard"],
  ] as const)(
    "with hookActive %s and sessionsJudged %s, not Audit-ready, gives %s",
    (hookActive, sessionsJudged, level) => {
      expect(teamLevel({ auditReady: false, hookActive, sessionsJudged })).toBe(level);
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "gives Audit-ready whenever auditReady, with hookActive %s and sessionsJudged %s",
    (hookActive, sessionsJudged) => {
      expect(teamLevel({ auditReady: true, hookActive, sessionsJudged })).toBe("audit_ready");
    },
  );
});

describe("standardFacts", () => {
  it("reads the hook as the counts say, and the Judge as at least one session judged", () => {
    expect(standardFacts({ hook_active: true, judged: 0, needs_human_review: 0 })).toEqual({
      hookActive: true,
      sessionsJudged: false,
    });
    expect(standardFacts({ hook_active: false, judged: 1, needs_human_review: 1 })).toEqual({
      hookActive: false,
      sessionsJudged: true,
    });
  });
});

/** ISA2027 as the answer lists it; only its id matters to the Level. */
const ISA: AuditCatalogue = {
  id: "vda-isa-2027.1",
  name: "VDA ISA 2027.1",
  date: "2026-09-30",
  credit: "© 2026 ENX Association.",
  licence: "CC BY-ND 4.0",
  licence_url: "https://creativecommons.org/licenses/by-nd/4.0/",
};

/** A row of ISA2027 at `review_state`, its other fields as any row has them. */
const row = (ref: string, review_state: ReviewState): AuditControl => ({
  catalogue: ISA.id,
  ref,
  question: `Question ${ref}?`,
  verdict: "evidenced",
  review_state,
  reviewed_verdict: review_state === "reviewed" ? "evidenced" : null,
  gap: false,
});

/** A not-yet answer with ISA2027 on (or `catalogues`) and `controls`; the counts don't matter to the Level. */
const notYet = (controls: AuditControl[], catalogues: AuditCatalogue[] = [ISA]): AuditAnswer => ({
  answer: "not_yet",
  gaps: 0,
  waiting: 0,
  catalogues,
  controls,
});

describe("auditReadyOfAnswer", () => {
  it("is false with no Catalogue on", () => {
    expect(
      auditReadyOfAnswer({
        answer: "no_catalogue",
        gaps: 0,
        waiting: 0,
        catalogues: [],
        controls: [],
      }),
    ).toBe(false);
  });

  it("is false while a row waits for its first review", () => {
    expect(
      auditReadyOfAnswer(notYet([row("1.3.3", "reviewed"), row("4.1.3", "not_reviewed")])),
    ).toBe(false);
  });

  it("is true once every row has a review, one changed since review included", () => {
    expect(
      auditReadyOfAnswer(notYet([row("1.3.3", "reviewed"), row("4.1.3", "changed_since_review")])),
    ).toBe(true);
  });

  it("is false for a Catalogue on with no row, as it judges no Control", () => {
    expect(auditReadyOfAnswer(notYet([]))).toBe(false);
  });

  it("is false while a second Catalogue on judges no Control, though every row of the first has a review", () => {
    // Warden has one Catalogue today: the second's id stands for the next one it gets.
    const second = { ...ISA, id: "a-second-catalogue" as CatalogueId };
    expect(auditReadyOfAnswer(notYet([row("1.3.3", "reviewed")], [ISA, second]))).toBe(false);
  });
});
