// A Team's spending on paid model calls (spec #225, slice 7a, story 10, threat J5): the ledger (0021_spending_ledger),
// and the Team's spending today, which the per-Team daily limit reads. A paid call is reserved before it's made: under
// a per-Team lock, the store checks today's spending against the limit and adds the call at UNPRICED_CALL_USD, in one
// transaction, so overlapping runs of one Team take turns and the limit holds. After the answer, `settle` adds a
// correction row that brings the call to the cost the answer stated, or to nothing for a call the provider refused
// unbilled; the ledger stays append-only. Shared code, not a module's, so Scans and chat record to the same ledger
// when they make paid calls: the limit counts every spending path. Every call runs inside `withTeam`, so row-level
// security keeps each Team to its own rows.
import { sql, type Transaction } from "kysely";
import type { CostBasis, Database, SpendingPath } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** What a Team may spend on paid model calls in one UTC day, every path together. Its own model costs Warden nothing. */
export const TEAM_DAILY_SPENDING_LIMIT_USD = 1;

/**
 * The cost a paid call is reserved at, and keeps when its answer states none: a call that timed out, lost its
 * connection, failed upstream (5xx) or answered without `usage.cost`.
 */
export const UNPRICED_CALL_USD = 0.05;

/** What a paid call cost, as its answer (or its failure) settles it. */
export type Settlement = {
  /** The tokens the answer stated; null when it stated none. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  costBasis: CostBasis;
};

/** A call the provider refused before it ran (a 4xx): it cost nothing. */
export const UNBILLED: Settlement = {
  inputTokens: null,
  outputTokens: null,
  costUsd: 0,
  costBasis: "unbilled",
};

/** One paid call whose cost is known, as the ledger records it. */
export type SpendingEntry = {
  path: SpendingPath;
  /** The model's name, as the call sent it. */
  model: string;
} & Settlement;

/** A paid call's reserved row, which its settlement corrects. */
export type Reservation = { id: string };

export interface Spending {
  /** Records one paid call made for the Team, now, at its known cost. */
  record(team: string, entry: SpendingEntry): Promise<void>;
  /**
   * Reserves one paid call at UNPRICED_CALL_USD, or reserves nothing and answers the Team's spending today when it
   * reached TEAM_DAILY_SPENDING_LIMIT_USD. The Team's reservations take turns.
   */
  reserve(
    team: string,
    call: { path: SpendingPath; model: string },
  ): Promise<Reservation | { limited: number }>;
  /** Brings a reserved call to what it cost, with one correction row; a reservation is settled at most once. */
  settle(team: string, reservation: Reservation, cost: Settlement): Promise<void>;
  /** What the Team has spent since the start of the current UTC day, on every path, in US dollars. */
  spentToday(team: string): Promise<number>;
}

/** What the Team `tx` is scoped to has spent today. */
async function spentIn(tx: Transaction<Database>): Promise<number> {
  const { spent } = await tx
    .selectFrom("spending_ledger")
    .select(sql<string>`coalesce(sum(cost_usd), 0)`.as("spent"))
    .where("at", ">=", sql<Date>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
    .executeTakeFirstOrThrow();
  return Number(spent);
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

    reserve(team, { path, model }) {
      return withTeam(team, async (tx) => {
        // Held to the transaction's end: the next reservation for the Team sums after this one's row is in.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`spending:${team}`}, 0))`.execute(
          tx,
        );
        const spent = await spentIn(tx);
        if (spent >= TEAM_DAILY_SPENDING_LIMIT_USD) return { limited: spent };
        const { id } = await tx
          .insertInto("spending_ledger")
          .values({
            team_id: team,
            path,
            model,
            input_tokens: null,
            output_tokens: null,
            cost_usd: UNPRICED_CALL_USD,
            cost_basis: "assumed",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { id };
      });
    },

    async settle(team, { id }, cost) {
      await withTeam(team, (tx) =>
        tx
          .insertInto("spending_ledger")
          .columns([
            "team_id",
            "path",
            "model",
            "input_tokens",
            "output_tokens",
            "cost_usd",
            "cost_basis",
            "corrects",
          ])
          // The difference is taken in numeric, so the reserved and stated costs add up exactly.
          .expression((eb) =>
            eb
              .selectFrom("spending_ledger")
              .select([
                "team_id",
                "path",
                "model",
                sql<number | null>`${cost.inputTokens}::integer`.as("input_tokens"),
                sql<number | null>`${cost.outputTokens}::integer`.as("output_tokens"),
                sql<string>`${String(cost.costUsd)}::numeric - cost_usd`.as("cost_usd"),
                sql<CostBasis>`${cost.costBasis}::text`.as("cost_basis"),
                "id",
              ])
              .where("id", "=", id),
          )
          .execute(),
      );
    },

    spentToday(team) {
      return withTeam(team, spentIn);
    },
  };
}
