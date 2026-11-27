// The review-state rule's case table (spec #341, slice 3, stories 4 and 7): where a Control stands with its reviews,
// from the Verdict worked out now and its reviews, newest first. Pure: no database, no clock.
import { ReviewedVerdict, type Verdict } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { reviewStateOf, type ReviewedOn } from "./review-state.ts";

const confirmed = (verdict: Verdict): ReviewedOn => ({ worked_out_verdict: verdict, verdict });
const overridden = (worked_out_verdict: Verdict, verdict: ReviewedVerdict): ReviewedOn => ({
  worked_out_verdict,
  verdict,
});

describe("reviewStateOf", () => {
  it("answers not reviewed, with no reviewed Verdict, for a Control with no review", () => {
    expect(reviewStateOf("evidenced", [])).toEqual({
      review_state: "not_reviewed",
      reviewed_verdict: null,
    });
  });

  it("answers reviewed with the confirmed Verdict when the newest review was made on the Verdict worked out now", () => {
    expect(reviewStateOf("partly_evidenced", [confirmed("partly_evidenced")])).toEqual({
      review_state: "reviewed",
      reviewed_verdict: "partly_evidenced",
    });
  });

  it.each(ReviewedVerdict.options.filter((verdict) => verdict !== "not_evidenced"))(
    "answers reviewed with the Lead's Verdict for an override of not_evidenced to %s",
    (verdict) => {
      expect(reviewStateOf("not_evidenced", [overridden("not_evidenced", verdict)])).toEqual({
        review_state: "reviewed",
        reviewed_verdict: verdict,
      });
    },
  );

  it("answers reviewed with the Lead's not_evidenced for an override of evidenced", () => {
    expect(reviewStateOf("evidenced", [overridden("evidenced", "not_evidenced")])).toEqual({
      review_state: "reviewed",
      reviewed_verdict: "not_evidenced",
    });
  });

  it("answers changed since review, with no reviewed Verdict, when the Verdict worked out now differs", () => {
    expect(reviewStateOf("partly_evidenced", [confirmed("evidenced")])).toEqual({
      review_state: "changed_since_review",
      reviewed_verdict: null,
    });
  });

  it("answers changed since review when an override's worked-out Verdict differs, even if its own Verdict matches", () => {
    expect(
      reviewStateOf("partly_evidenced", [overridden("evidenced", "partly_evidenced")]),
    ).toEqual({ review_state: "changed_since_review", reviewed_verdict: null });
  });

  it("counts only the newest review: an older one on the Verdict worked out now doesn't bring the Control back", () => {
    expect(
      reviewStateOf("evidenced", [confirmed("not_evidenced"), confirmed("evidenced")]),
    ).toEqual({ review_state: "changed_since_review", reviewed_verdict: null });
  });

  it("counts only the newest review: a matching newest one stands over an older differing one", () => {
    expect(
      reviewStateOf("evidenced", [
        overridden("evidenced", "not_applicable"),
        confirmed("partly_evidenced"),
      ]),
    ).toEqual({ review_state: "reviewed", reviewed_verdict: "not_applicable" });
  });
});
