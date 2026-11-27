// The Overview's counts of a Team's Agent sessions (spec #225, slice 8b, story 12): whether the hook is sending, and
// what the Judge judged, over the Overview's period. Read from `agent_sessions` alone, never `agent_events`, whose rows
// are dropped once judged and after 7 days. Inside `withTeam`, so row-level security keeps each Team's rows to itself
// (ADR 0006). The app reads it through `AgentSessionReads` (ADR 0005: it imports no module).
import { sql } from "kysely";
import type { AgentSessionReads } from "../../app.ts";
import type { WithTeam } from "../../with-team.ts";
import type { AgentSessionTables, SessionOutcome } from "./agent-sessions.ts";

const NEEDS_REVIEW: SessionOutcome = "needs_human_review";

/**
 * Over the last `days` days by the database's clock, the clock the hook and the Judge write by: whether any session's
 * last event came in it, how many sessions were judged in it (each once, at its latest Judge run, whatever its
 * outcome), and how many of those hold `needs_human_review`.
 */
export function createSessionActivity({ withTeam }: { withTeam: WithTeam }): AgentSessionReads {
  return {
    activity(team, days) {
      return withTeam(team, async (tx) => {
        const since = sql<Date>`now() - make_interval(days => ${days}::int)`;
        const judged = sql<boolean>`judged_at > ${since}`;
        const row = await tx
          .$extendTables<AgentSessionTables>()
          .selectFrom("agent_sessions")
          .select([
            sql<boolean>`coalesce(bool_or(last_event_at > ${since}), false)`.as("hook_active"),
            sql<string>`count(*) filter (where ${judged})`.as("judged"),
            sql<string>`count(*) filter (where ${judged} and outcome = ${NEEDS_REVIEW})`.as(
              "needs_human_review",
            ),
          ])
          .executeTakeFirstOrThrow();
        return {
          hook_active: row.hook_active,
          judged: Number(row.judged),
          needs_human_review: Number(row.needs_human_review),
        };
      });
    },
  };
}
