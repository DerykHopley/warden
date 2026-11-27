// The Audit-ready fact the Overview works out from Vouch's answer in hand (spec #341, slice 4, story 9), by the rule
// Vouch's `isAuditReady` reads from its switches and reviews. Pure: no database, no clock.
import type { AuditAnswer, AuditControl, ReviewState } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { auditReadyOfAnswer } from "./level.ts";

/** A row of ISA2027 at `review_state`, its other fields as any row has them. */
const row = (ref: string, review_state: ReviewState): AuditControl => ({
  catalogue: "vda-isa-2027.1",
  ref,
  question: `Question ${ref}?`,
  verdict: "evidenced",
  review_state,
  reviewed_verdict: review_state === "reviewed" ? "evidenced" : null,
  gap: false,
});

/** A not-yet answer with `controls`; the counts don't matter to the Level. */
const notYet = (...controls: AuditControl[]): AuditAnswer => ({
  answer: "not_yet",
  gaps: 0,
  waiting: 0,
  controls,
});

describe("auditReadyOfAnswer", () => {
  it("is false with no Catalogue on", () => {
    expect(auditReadyOfAnswer({ answer: "no_catalogue", gaps: 0, waiting: 0, controls: [] })).toBe(
      false,
    );
  });

  it("is false while a row waits for its first review", () => {
    expect(auditReadyOfAnswer(notYet(row("1.3.3", "reviewed"), row("4.1.3", "not_reviewed")))).toBe(
      false,
    );
  });

  it("is true once every row has a review, one changed since review included", () => {
    expect(
      auditReadyOfAnswer(notYet(row("1.3.3", "reviewed"), row("4.1.3", "changed_since_review"))),
    ).toBe(true);
  });

  it("is false for a Catalogue on with no row, as it judges no Control", () => {
    expect(auditReadyOfAnswer(notYet())).toBe(false);
  });
});
