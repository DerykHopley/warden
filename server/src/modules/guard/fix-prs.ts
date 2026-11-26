// A Team's Fix PRs (#224, owner answer 2, story 15): each PR Warden's write GitHub app opened for a Finding, kept as an
// append-only record keyed by the Team and the Finding, beside it rather than in Finding v1. Every call runs inside
// `withTeam`, so row-level security keeps each Team to its own rows (ADR 0006), and the key to `findings` keeps a row to
// one of its own Team's Findings.
import type { Selectable } from "kysely";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";

/** A Fix PR as the store answers it: its Finding, the PR's URL, number and branch, who opened it and when. */
export type FixPr = {
  findingId: string;
  url: string;
  number: number;
  branch: string;
  openedBy: string;
  openedAt: Date;
};

export interface FixPrs {
  /**
   * Records a PR opened for one of the Team's Findings and answers it. When the Finding already holds a PR of that
   * number, writes nothing and answers the held one. Throws, writing nothing, for a Finding the Team doesn't have.
   */
  record(team: string, input: Omit<FixPr, "openedAt">): Promise<FixPr>;
  /** The newest PR recorded for the Team's Finding, or undefined when it has none. */
  newest(team: string, findingId: string): Promise<FixPr | undefined>;
}

const fixPr = (row: Selectable<Database["fix_prs"]>): FixPr => ({
  findingId: row.finding_id,
  url: row.url,
  number: row.number,
  branch: row.branch,
  openedBy: row.opened_by,
  openedAt: row.at,
});

export function createFixPrs({ withTeam }: { withTeam: WithTeam }): FixPrs {
  return {
    record(team, { findingId, url, number, branch, openedBy }) {
      return withTeam(team, async (tx) => {
        const inserted = await tx
          .insertInto("fix_prs")
          .values({
            team_id: team,
            finding_id: findingId,
            url,
            number,
            branch,
            opened_by: openedBy,
          })
          .onConflict((conflict) =>
            conflict.columns(["team_id", "finding_id", "number"]).doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
        if (inserted) return fixPr(inserted);
        // The PR is held: a record made at once with this one waited on its row, which this statement now reads.
        const held = await tx
          .selectFrom("fix_prs")
          .selectAll()
          .where("finding_id", "=", findingId)
          .where("number", "=", number)
          .executeTakeFirstOrThrow();
        return fixPr(held);
      });
    },

    newest(team, findingId) {
      return withTeam(team, async (tx) => {
        const row = await tx
          .selectFrom("fix_prs")
          .selectAll()
          .where("finding_id", "=", findingId)
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst();
        return row && fixPr(row);
      });
    },
  };
}
