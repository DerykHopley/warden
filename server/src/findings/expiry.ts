// The daily expiry (glossary: Accepted; ADR 0009): every Accepted Finding whose `accepted_until` is at or before `now`
// reopens, whether or not a Scan sees it, with a history row naming the Job. Runs inside the caller's `withTeam`
// transaction, under the Team's Findings lock, so it waits for a reconcile or a decision rather than racing it.
import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import { notAccepted } from "./decisions.ts";
import { lockTeamFindings } from "./reconcile.ts";
import { fromRow, isoDateTime, toRow } from "./rows.ts";

/** The history rows' actor id: the Job that reopened the Finding. */
export const DAILY_EXPIRY = "daily-expiry";

/** How long one Team's expiry may wait for its lock, and for any one statement, before it fails. */
export type ExpiryLimits = { lockTimeoutMs?: number; statementTimeoutMs?: number };

/**
 * Reopens the Team's expired acceptances as of `now`, and returns their ids. A merged Finding is left alone. A Team
 * stuck behind its lock (a long reconcile, a hung transaction) fails after `lockTimeoutMs`, and a slow statement after
 * `statementTimeoutMs`, both for this transaction only, so the Job logs it and goes on to the next Team.
 */
export async function applyExpiry(
  tx: Transaction<Database>,
  team: string,
  now: Date,
  { lockTimeoutMs = 30_000, statementTimeoutMs = 60_000 }: ExpiryLimits = {},
): Promise<string[]> {
  await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                   set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`.execute(tx);
  await lockTeamFindings(tx, team);
  const expired = (
    await tx
      .selectFrom("findings")
      .selectAll()
      .where("team_id", "=", team)
      .where("status", "=", "accepted")
      .where("accepted_until", "<=", now)
      .where("moved_to", "is", null)
      .orderBy("id")
      .execute()
  ).map(fromRow);
  if (expired.length === 0) return [];

  for (const finding of expired) {
    const { team_id, id, ...fields } = toRow({ ...finding, status: "open", ...notAccepted });
    await tx
      .updateTable("findings")
      .set(fields)
      .where("team_id", "=", team_id)
      .where("id", "=", id)
      .execute();
  }
  await tx
    .insertInto("finding_history")
    .values(
      expired.map((finding) => ({
        team_id: team,
        finding_id: finding.id,
        status_before: finding.status,
        status_after: "open" as const,
        severity_before: finding.severity,
        severity_after: finding.severity,
        actor_kind: "job" as const,
        actor_id: DAILY_EXPIRY,
        reason: `The acceptance expired at ${finding.accepted_until}; the daily Job reopened it at ${isoDateTime(now)}`,
      })),
    )
    .execute();
  return expired.map((finding) => finding.id);
}
