// A Team's Agent sessions and their Agent events (spec #225, slice 1, #183): what the hook endpoint stores from each
// event Claude Code posts (0019_agent_sessions), and what the Judge reads of an ended session then drops (slice 5a,
// #443). Every call runs inside `withTeam`, so row-level security keeps each Team's rows to itself (ADR 0006); the Team
// is always the hook token's or the Job's, never the event's.
import { sql, type Generated } from "kysely";
import type { WithTeam } from "../../with-team.ts";

/** A value JSON can hold, as an Agent event's kept fields are stored in `agent_events.fields` (jsonb). */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Guard's Agent session tables, added to `withTeam`'s transaction with `$extendTables`, so `schema.ts` stays as it
 * is. A type, not an interface: `$extendTables` needs the index signature a type alias has.
 */
export type AgentSessionTables = {
  /** One row per (Team, Claude Code's session_id). */
  agent_sessions: {
    team_id: string;
    session_id: string;
    developer: string | null;
    agent: "claude-code";
    started_at: Generated<Date>;
    last_event_at: Generated<Date>;
    ended_at: Date | null;
    judged_at: Date | null;
    outcome: string | null;
    refused_events: Generated<number>;
  };
  /** One row per stored event, holding only what the Team's Privacy tier kept. */
  agent_events: {
    team_id: string;
    session_id: string;
    seq: Generated<string>;
    received_at: Generated<Date>;
    name: string;
    tool: string | null;
    fields: Record<string, JsonValue>;
  };
};

/** One event to store, already filtered to the Team's Privacy tier and redacted. */
export type StoredEvent = {
  sessionId: string;
  /** Claude Code's hook_event_name. */
  name: string;
  /** Its tool_name on a tool event, else null. */
  tool: string | null;
  /** What the Team's Privacy tier kept, redacted. */
  fields: Record<string, JsonValue>;
  /** The developer's pseudonym, or null when the event named none. */
  developer: string | null;
  /** Whether the event ends the session (SessionEnd). */
  ended: boolean;
  /** Events refused for the Team's rate limit since the session's last stored one, added to its count. */
  refusedEvents: number;
};

/** One stored event as the Judge reads it. */
export type ReadAgentEvent = {
  /**
   * Its stored row's place in the Team's events (a bigint, as text): what `markJudged` drops it by. Not the masked
   * event's `seq`, which is its 0-based place among the events one run read.
   */
  rowSeq: string;
  receivedAt: Date;
  name: string;
  tool: string | null;
  fields: Record<string, JsonValue>;
};

/** What the Judge found in a session: one Finding or more, none, or an answer a person must read. */
export type SessionOutcome = "flagged" | "clean" | "needs_human_review";

/**
 * The outcomes, lowest first. A session's outcome never moves down: a later run over its late events can't make a
 * flagged session clean while the first run's Finding stands, nor wipe a review a person still has to do.
 */
export const OUTCOME_ORDER: readonly SessionOutcome[] = ["clean", "needs_human_review", "flagged"];

export interface AgentSessions {
  /**
   * Stores one event in one transaction: makes the session on its first event (or updates it: its last event's time,
   * its end, its refused count, and its developer when it had none yet), then adds the event.
   */
  store(team: string, event: StoredEvent): Promise<void>;
  /**
   * An ended session's events, in stored order: undefined when the Team holds no such session, it hasn't ended, or it
   * holds no events (none sent, or the Judge already dropped them).
   */
  readEnded(team: string, sessionId: string): Promise<ReadAgentEvent[] | undefined>;
  /**
   * In one transaction, marks the session judged now, and drops exactly the events `rowSeqs` names: the ones the Judge
   * read. An event stored after the read stays, for its own run. The session's outcome becomes the higher in
   * OUTCOME_ORDER of the one it held and `outcome`, and is what this answers.
   */
  markJudged(
    team: string,
    sessionId: string,
    judged: { outcome: SessionOutcome; rowSeqs: readonly string[] },
  ): Promise<SessionOutcome>;
}

export function createAgentSessions({ withTeam }: { withTeam: WithTeam }): AgentSessions {
  return {
    store(team, event) {
      return withTeam(team, async (tx) => {
        const db = tx.$extendTables<AgentSessionTables>();
        // Two first events of a session sent at once: the insert's conflict clause makes the second an update.
        await db
          .insertInto("agent_sessions")
          .values({
            team_id: team,
            session_id: event.sessionId,
            developer: event.developer,
            agent: "claude-code",
            ended_at: event.ended ? sql<Date>`now()` : null,
            judged_at: null,
            outcome: null,
            refused_events: event.refusedEvents,
          })
          .onConflict((conflict) =>
            conflict.columns(["team_id", "session_id"]).doUpdateSet({
              developer: sql`coalesce(agent_sessions.developer, excluded.developer)`,
              last_event_at: sql`now()`,
              ended_at: sql`coalesce(excluded.ended_at, agent_sessions.ended_at)`,
              refused_events: sql`agent_sessions.refused_events + excluded.refused_events`,
            }),
          )
          .execute();
        await db
          .insertInto("agent_events")
          .values({
            team_id: team,
            session_id: event.sessionId,
            name: event.name,
            tool: event.tool,
            // jsonb goes in as its JSON text, as schema.ts's JSON columns do.
            fields: sql`${JSON.stringify(event.fields)}::jsonb`,
          })
          .execute();
      });
    },

    readEnded(team, sessionId) {
      return withTeam(team, async (tx) => {
        const db = tx.$extendTables<AgentSessionTables>();
        const session = await db
          .selectFrom("agent_sessions")
          .select("ended_at")
          .where("session_id", "=", sessionId)
          .executeTakeFirst();
        if (session?.ended_at == null) return undefined;
        const rows = await db
          .selectFrom("agent_events")
          .select(["seq", "received_at", "name", "tool", "fields"])
          .where("session_id", "=", sessionId)
          .orderBy("seq")
          .execute();
        if (rows.length === 0) return undefined;
        return rows.map((row) => ({
          rowSeq: String(row.seq),
          receivedAt: row.received_at,
          name: row.name,
          tool: row.tool,
          fields: row.fields,
        }));
      });
    },

    markJudged(team, sessionId, { outcome, rowSeqs }) {
      return withTeam(team, async (tx) => {
        const db = tx.$extendTables<AgentSessionTables>();
        // Compared in the update itself: of two marks at once, the second waits on the row's lock, then compares with
        // the outcome the first wrote.
        const order = sql`${[...OUTCOME_ORDER]}::text[]`;
        const marked = await db
          .updateTable("agent_sessions")
          .set({
            judged_at: sql<Date>`now()`,
            outcome: sql<string>`case
              when coalesce(array_position(${order}, agent_sessions.outcome), 0)
                >= array_position(${order}, ${outcome}::text)
              then agent_sessions.outcome else ${outcome}::text end`,
          })
          .where("session_id", "=", sessionId)
          .returning("outcome")
          .executeTakeFirst();
        // One array parameter, however many events the run read.
        await db
          .deleteFrom("agent_events")
          .where("session_id", "=", sessionId)
          .where(sql<boolean>`seq = any(${[...rowSeqs]}::bigint[])`)
          .execute();
        return (marked?.outcome as SessionOutcome | null | undefined) ?? outcome;
      });
    },
  };
}
