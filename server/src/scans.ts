// Queued Scans (ADR 0009): a Lead's start writes a row under the session's Team, the Scan Job reads it back by its id
// and Team and moves its state. Shared code like the Findings module: it never imports a module. Each module's scanner
// comes in as `Scanners`, wired by the start-up files from `wiring.ts`, and the starter as a
// `ScanJobStarter`.
import { randomUUID } from "node:crypto";
import { sql, type Selectable, type Transaction } from "kysely";
import { ScanBody, type Asset, type Module, type RuleId, type ScanState } from "@warden/contracts";
import type { ScanRecorder } from "./findings/index.ts";
import type { Logger } from "./log.ts";
import type { Database } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/**
 * At most this many Scans per Team in a rolling hour, counted from the table, failed ones included, except a Scan the
 * time limit below ended.
 */
export const SCANS_PER_HOUR = 10;

/**
 * A Scan still queued this long after its `queued_at` never had its Job start (the Job takes 15 to 29 s to start), and
 * is ended as failed with `ended_at` exactly this long after `queued_at`: the moment the limit ran out, and the mark
 * the hourly count leaves it out by. A Job that starts later still runs it, as a rerun of a failed Scan.
 */
export const QUEUED_SCAN_LIMIT_MINUTES = 15;

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
  /**
   * Which of `assets` the Team still holds, in the order given (story 15). The Scan Job asks just before it scans, as
   * a start's AssetCheck ran when the Scan was queued and the Team may have dropped one since; the Scan then covers
   * only these. A module without it scans the Assets as queued.
   */
  held?(team: string, assets: readonly Asset[]): Promise<Asset[]>;
}

/** Each module's scanner, as a start-up file wires them; a module without one can't be scanned. */
export type Scanners = Partial<Record<Module, Scanner>>;

/**
 * A module's check of a start's Assets: the refusal of the first one the Team can't scan with that module, worded for
 * the Lead in the module's own terms and naming its place (`assets[i]`), or undefined when it can scan them all.
 */
export type AssetCheck = (team: string, assets: readonly Asset[]) => Promise<string | undefined>;

/**
 * Each module's AssetCheck, as the start-up file wires them: a start it refuses is 400 with its words. A module
 * without one takes any Assets the body allows.
 */
export type AssetChecks = Partial<Record<Module, AssetCheck>>;

/**
 * Starts the Scan Job for one queued Scan, handing it only the Scan's id and Team (ADR 0009): the Job reads the rest
 * from the row. Resolves once the Job is started, not when it ends.
 */
export type ScanJobStarter = (input: { scanId: string; team: string }) => Promise<void>;

/** The variables the Scan Job takes its Scan from (ADR 0009): an execution's only override, a child's only own two. */
export const SCAN_ID_VARIABLE = "WARDEN_SCAN_ID";
export const TEAM_VARIABLE = "WARDEN_TEAM";

/**
 * What a starter throws when it can't tell whether the Job started: its request may have reached the Job's host before
 * the answer was lost. The Scan stays queued, as a failed start would make the Lead start another; if the Job never
 * started, QUEUED_SCAN_LIMIT_MINUTES ends it.
 */
export class ScanJobStartUnknown extends Error {
  override name = "ScanJobStartUnknown";
}

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
   * Moves the Team's Scan to `state`, answering it as moved; undefined when nothing moved, for an id the Team doesn't
   * have or a move MOVES_FROM doesn't allow (never out of done), so a late attempt can't undo a finished Scan.
   * Running clears the end and sets the start: the start reconcile already applied this Scan's id under, so a retried
   * Job reconciles under the same pair and changes nothing (ADR 0009); otherwise now, so a Scan started after an
   * attempt that reconciled nothing doesn't count as newer than the rerun. Done and failed set the end.
   */
  move(
    team: string,
    id: string,
    state: Exclude<ScanState, "queued">,
  ): Promise<ScanBody | undefined>;
}

/**
 * What `startScan` did: started the queued Scan's Job; couldn't tell whether it started, so the Scan stays queued;
 * couldn't start it, so the Scan was moved to failed (the queued Scan when the move answered nothing or threw); or
 * refused it as `queue` does, queuing and starting nothing.
 */
export type StartOutcome =
  | { kind: "started"; scan: ScanBody }
  | { kind: "start_unknown"; scan: ScanBody }
  | { kind: "start_failed"; scan: ScanBody }
  | Extract<QueueOutcome, { kind: "rate_limited" }>;

/**
 * Queues one Scan for the Team, then starts its Job with only the Scan's id and Team (ADR 0009). Shared by a Lead's
 * start and the first Scan after a link. A `queue` that throws throws here, with nothing started.
 */
export async function startScan(
  { scans, startScanJob, logger }: { scans: Scans; startScanJob: ScanJobStarter; logger: Logger },
  team: string,
  input: Parameters<Scans["queue"]>[1],
): Promise<StartOutcome> {
  const queued = await scans.queue(team, input);
  if (queued.kind === "rate_limited") return queued;
  const scanId = queued.scan.id;
  try {
    await startScanJob({ scanId, team });
  } catch (error) {
    // The Job may have started: the Scan stays queued, and whoever asked follows it rather than start another.
    if (error instanceof ScanJobStartUnknown) {
      logger.warn("The Scan Job's start is unknown; the Scan stays queued", {
        scanId,
        team,
        error,
      });
      return { kind: "start_unknown", scan: queued.scan };
    }
    // Logged before the move, so a failed move can't hide why the start failed.
    logger.error("The Scan Job couldn't be started; marking the Scan failed", {
      scanId,
      team,
      error,
    });
    let moved: ScanBody | undefined;
    try {
      moved = await scans.move(team, scanId, "failed");
    } catch (moveError) {
      logger.error("The Scan couldn't be marked failed; it stays queued", {
        scanId,
        team,
        error: moveError,
      });
    }
    return { kind: "start_failed", scan: moved ?? queued.scan };
  }
  return { kind: "started", scan: queued.scan };
}

/**
 * The states each move may start from. Running from failed is a rerun, and from running a retried execution; done
 * from failed is an attempt that reconciled after a late one failed it. Nothing moves out of done.
 */
const MOVES_FROM = {
  running: ["queued", "running", "failed"],
  done: ["running", "failed"],
  failed: ["queued", "running"],
} as const satisfies Record<Exclude<ScanState, "queued">, readonly ScanState[]>;

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

/** QUEUED_SCAN_LIMIT_MINUTES as an interval, a literal so the database can compare `ended_at` to it exactly. */
const QUEUED_LIMIT = sql<string>`make_interval(mins => ${sql.lit(QUEUED_SCAN_LIMIT_MINUTES)})`;

/**
 * Ends the transaction's Team's Scans still queued QUEUED_SCAN_LIMIT_MINUTES after they were queued, as failed and
 * ended when the limit ran out. Row-level security binds it to the Team `withTeam` set; a Scan that ever started is
 * past `queued` and never touched.
 */
async function endStaleQueued(tx: Transaction<Database>): Promise<void> {
  await tx
    .updateTable("scan_requests")
    .set({ state: "failed", ended_at: sql<Date>`queued_at + ${QUEUED_LIMIT}` })
    .where("state", "=", "queued")
    .where("queued_at", "<=", sql<Date>`now() - ${QUEUED_LIMIT}`)
    .execute();
}

export function createScans({ withTeam }: { withTeam: WithTeam }): Scans {
  return {
    queue(team, { module, assets, rules, requestedBy }) {
      return withTeam(team, async (tx): Promise<QueueOutcome> => {
        // Its own key, apart from reconcile's per-Team lock, so a start never waits on a Scan being applied.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`scans:${team}`}, 0))`.execute(
          tx,
        );
        await endStaleQueued(tx);
        // A Scan the time limit ended is the only one with no start and an end exactly that limit after its queueing;
        // it never ran, so it doesn't count. A start the route failed ends within seconds, and still counts.
        const recent = await tx
          .selectFrom("scan_requests")
          .select([
            sql<number>`count(*)::int`.as("count"),
            sql<number>`ceil(extract(epoch from min(queued_at) + interval '1 hour' - now()))::int`.as(
              "retry_after",
            ),
          ])
          .where("queued_at", ">", sql<Date>`now() - interval '1 hour'`)
          .where(
            sql<boolean>`not (started_at is null and ended_at is not distinct from queued_at + ${QUEUED_LIMIT})`,
          )
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
        await endStaleQueued(tx);
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
              ? {
                  state,
                  started_at: sql<Date>`coalesce(
                    (select s.started_at from scans s
                      where s.team_id = scan_requests.team_id and s.id = scan_requests.id),
                    now()
                  )`,
                  ended_at: null,
                }
              : { state, ended_at: sql<Date>`now()` },
          )
          .where("id", "=", id)
          .where("state", "in", MOVES_FROM[state])
          .returningAll()
          .executeTakeFirst();
        return row && toBody(row);
      });
    },
  };
}
