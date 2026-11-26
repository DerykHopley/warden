// The review log (Vouch, spec #341, slice 3, stories 4 to 7): each review a Lead (or an Admin) made of a judged
// Control's Verdict, one row per review in `control_reviews` (0018), never changed. This store is the table's only
// writer, and every call runs inside `withTeam`, so row-level security keeps each Team to its own rows (ADR 0006).
import type { CatalogueId, ReviewedVerdict, ReviewOutcome, Verdict } from "@warden/contracts";
import type { WithTeam } from "../../with-team.ts";

/**
 * One review as the store answers it: its Control, the Verdict worked out when it was written, what the reviewer did
 * and the Verdict they gave, their reason (null on a confirm without one), who reviewed (a Clerk user id) and when.
 */
export type LoggedReview = {
  id: string;
  controlRef: string;
  workedOutVerdict: Verdict;
  outcome: ReviewOutcome;
  verdict: ReviewedVerdict;
  reason: string | null;
  reviewedBy: string;
  reviewedAt: Date;
};

export interface ControlReviews {
  /** Writes one review of a Control of `catalogue`, at the time now. */
  add(
    team: string,
    review: Omit<LoggedReview, "id" | "reviewedAt"> & { catalogue: CatalogueId },
  ): Promise<void>;
  /** Every review the Team made of `catalogue`'s Controls, newest first. */
  list(team: string, catalogue: CatalogueId): Promise<LoggedReview[]>;
}

export function createControlReviews({ withTeam }: { withTeam: WithTeam }): ControlReviews {
  return {
    async add(team, review) {
      await withTeam(team, (tx) =>
        tx
          .insertInto("control_reviews")
          .values({
            team_id: team,
            catalogue: review.catalogue,
            control_ref: review.controlRef,
            worked_out_verdict: review.workedOutVerdict,
            outcome: review.outcome,
            verdict: review.verdict,
            reason: review.reason,
            reviewed_by: review.reviewedBy,
          })
          .execute(),
      );
    },

    async list(team, catalogue) {
      const rows = await withTeam(team, (tx) =>
        tx
          .selectFrom("control_reviews")
          .selectAll()
          .where("catalogue", "=", catalogue)
          .orderBy("id", "desc")
          .execute(),
      );
      return rows.map((row) => ({
        id: row.id,
        controlRef: row.control_ref,
        workedOutVerdict: row.worked_out_verdict,
        outcome: row.outcome,
        verdict: row.verdict,
        reason: row.reason,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
      }));
    },
  };
}
