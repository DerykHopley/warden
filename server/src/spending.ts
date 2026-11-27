// A Team's spending on paid model calls (spec #225, slice 7a, story 10, threat J5): one ledger row per paid call
// (0021_spending_ledger), and the Team's spending today, which the per-Team daily limit reads before each paid call.
// Shared code, not a module's, so Scans and chat record to the same ledger when they make paid calls: the limit counts
// every spending path. Every call runs inside `withTeam`, so row-level security keeps each Team to its own rows.
import { sql } from "kysely";
import type { CostBasis, SpendingPath } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** What a Team may spend on paid model calls in one UTC day, every path together. Its own model costs Warden nothing. */
export const TEAM_DAILY_SPENDING_LIMIT_USD = 1;

/** The cost a paid call is recorded at when its answer states none: a failed call, a timeout, no `usage.cost`. */
export const UNPRICED_CALL_USD = 0.05;

/** One paid call, as the ledger records it. */
export type SpendingEntry = {
  path: SpendingPath;
  /** The model's name, as the call sent it. */
  model: string;
  /** The tokens the answer stated; null when it stated none. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  costBasis: CostBasis;
};

export interface Spending {
  /** Records one paid call made for the Team, now. */
  record(team: string, entry: SpendingEntry): Promise<void>;
  /** What the Team has spent since the start of the current UTC day, on every path, in US dollars. */
  spentToday(team: string): Promise<number>;
}

export function createSpending({ withTeam }: { withTeam: WithTeam }): Spending {
  return {
    async record(team, entry) {
      await withTeam(team, (tx) =>
        tx
          .insertInto("spending_ledger")
          .values({
            team_id: team,
            path: entry.path,
            model: entry.model,
            input_tokens: entry.inputTokens,
            output_tokens: entry.outputTokens,
            cost_usd: entry.costUsd,
            cost_basis: entry.costBasis,
          })
          .execute(),
      );
    },

    spentToday(team) {
      return withTeam(team, async (tx) => {
        const { spent } = await tx
          .selectFrom("spending_ledger")
          .select(sql<string>`coalesce(sum(cost_usd), 0)`.as("spent"))
          .where(
            "at",
            ">=",
            sql<Date>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
          )
          .executeTakeFirstOrThrow();
        return Number(spent);
      });
    },
  };
}
