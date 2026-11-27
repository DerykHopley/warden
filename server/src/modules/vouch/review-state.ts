// Where a Control stands with its reviews (spec #341, slice 3, stories 4 and 7). Pure: the Verdict worked out now and
// the Control's reviews in, its review state and reviewed Verdict out.
import type { ControlReview, ControlVerdict, Verdict } from "@warden/contracts";
import type { StoredControlReview } from "./control-reviews.ts";

/** What the rule reads of a review: the Verdict it was made on, and the Verdict it gave. */
export type ReviewedOn = Pick<ControlReview, "worked_out_verdict" | "verdict">;

/** What the rule reads of a stored review. */
export const reviewedOn = (stored: StoredControlReview): ReviewedOn => ({
  worked_out_verdict: stored.workedOutVerdict,
  verdict: stored.verdict,
});

/** `judged`, a judged Control before its reviews join, with where it stands with `reviews`, its own, newest first. */
export const withReviewState = (
  judged: Omit<ControlVerdict, "review_state" | "reviewed_verdict">,
  reviews: readonly ReviewedOn[],
): ControlVerdict => ({ ...judged, ...reviewStateOf(judged.verdict, reviews) });

/**
 * A Control's review state from `workedOut`, its Verdict worked out now, and its `reviews`, newest first. Only the
 * newest counts: made on the Verdict worked out now, the Control is reviewed and shows that review's Verdict; made on
 * another, it changed since review and shows no reviewed Verdict until it is reviewed again. An older review that
 * matches doesn't bring it back.
 */
export function reviewStateOf(
  workedOut: Verdict,
  reviews: readonly ReviewedOn[],
): Pick<ControlVerdict, "review_state" | "reviewed_verdict"> {
  const newest = reviews[0];
  if (newest === undefined) return { review_state: "not_reviewed", reviewed_verdict: null };
  if (newest.worked_out_verdict !== workedOut) {
    return { review_state: "changed_since_review", reviewed_verdict: null };
  }
  return { review_state: "reviewed", reviewed_verdict: newest.verdict };
}
