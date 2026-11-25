// Queued Scans (ADR 0009): a Lead's start writes a row under the session's Team, the Scan Job reads it back by its id
// and Team and moves its state. Shared code like the Findings module: it never imports a module. Each module's scanner
// comes in as `Scanners`, wired by the start-up files (index.ts and scan-job.ts), and the starter as a
// `ScanJobStarter`.
import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { ScanBody, type Asset, type Module, type RuleId, type ScanState } from "@warden/contracts";
import type { ScanRecorder } from "./findings/index.ts";
import type { Database } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** At most this many Scans per Team in a rolling hour, counted from the table, failed ones included. */
export const SCANS_PER_HOUR = 10;

/**
 * What a module hands over to be scanned: the Rules it checks, and the function that checks the Assets and reports
 * each problem through the recorder's `saw`. It throws for a Scan that couldn't run.
 */
export interface Scanner {
  rules: readonly RuleId[];
  scan(
    target: { team: string; assets: Asset[]; rules: RuleId[] },
    recorder: ScanRecorder,
  ): Promise<void>;
}

/** Each module's scanner, as a start-up file wires them; a module without one can't be scanned. */
export type Scanners = Partial<Record<Module, Scanner>>;

/**
 * Starts the Scan Job for one queued Scan, handing it only the Scan's id and Team (ADR 0009): the Job reads the rest
 * from the row. Resolves once the Job is started, not when it ends.
 */
export type ScanJobStarter = (input: { scanId: string; team: string }) => Promise<void>;

/** What `queue` did: queued the Scan, or refused it, writing nothing, until the Team's oldest start ages out. */
export type QueueOutcome =
  { kind: "queued"; scan: ScanBody } | { kind: "rate_limited"; retryAfterSeconds: number };

export interface Scans {
  /**
   * Queues one Scan, unless the Team has started SCANS_PER_HOUR in the last hour. The count and the insert run under a
   * per-Team lock in one transaction, so starts sent at once can't pass the limit together.
   */
  queue(
    team: string,
    input: { module: Module; assets: Asset[]; rules: RuleId[]; requestedBy: string },
  ): Promise<QueueOutcome>;
  /** The Team's Scan with this id; undefined for any other id, another Team's included. */
  get(team: string, id: string): Promise<ScanBody | undefined>;
  /**
   * Moves the Team's Scan to `state`, answering it as moved (undefined for an id the Team doesn't have). Running keeps
   * the first start, so a retried Job reconciles under the same id and start, and clears the end; done and failed set
   * the end.
   */
  move(
    team: string,
    id: string,
    state: Exclude<ScanState, "queued">,
  ): Promise<ScanBody | undefined>;
}

function toBody(row: Selectable<Database["scan_requests"]>): ScanBody {
  return ScanBody.parse({
    id: row.id,
    module: row.module,
    state: row.state,
    assets: row.assets,
    rules: row.rules,
    queued_at: row.queued_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    ended_at: row.ended_at?.toISOString() ?? null,
  });
}

export function createScans({ withTeam }: { withTeam: WithTeam }): Scans {
  return {
    queue(team, { module, assets, rules, requestedBy }) {
      return withTeam(team, async (tx): Promise<QueueOutcome> => {
        // Its own key, apart from reconcile's per-Team lock, so a start never waits on a Scan being applied.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`scans:${team}`}, 0))`.execute(
          tx,
        );
        const recent = await tx
          .selectFrom("scan_requests")
          .select([
            sql<number>`count(*)::int`.as("count"),
            sql<number>`ceil(extract(epoch from min(queued_at) + interval '1 hour' - now()))::int`.as(
              "retry_after",
            ),
          ])
          .where("queued_at", ">", sql<Date>`now() - interval '1 hour'`)
          .executeTakeFirstOrThrow();
        if (recent.count >= SCANS_PER_HOUR) {
          return { kind: "rate_limited", retryAfterSeconds: Math.max(1, recent.retry_after) };
        }
        const row = await tx
          .insertInto("scan_requests")
          .values({
            team_id: team,
            id: randomUUID(),
            module,
            assets: JSON.stringify(assets),
            rules,
            requested_by: requestedBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { kind: "queued", scan: toBody(row) };
      });
    },

    get(team, id) {
      return withTeam(team, async (tx) => {
        const row = await tx
          .selectFrom("scan_requests")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        return row && toBody(row);
      });
    },

    move(team, id, state) {
      return withTeam(team, async (tx) => {
        const row = await tx
          .updateTable("scan_requests")
          .set(
            state === "running"
              ? { state, started_at: sql<Date>`coalesce(started_at, now())`, ended_at: null }
              : { state, ended_at: sql<Date>`now()` },
          )
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        return row && toBody(row);
      });
    },
  };
}
