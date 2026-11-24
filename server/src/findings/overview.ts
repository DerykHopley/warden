// The numbers behind the Overview's trend (story 10), read from the Findings and their history inside one `withTeam`
// transaction. No table of its own: a Finding's Status at any time is its latest history row written by then.
import type { OverviewBody } from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import { isoDateTime } from "./rows.ts";

/** How many days the Overview's trend looks back over. */
export const OVERVIEW_PERIOD_DAYS = 30;

/** What the Findings module answers for the Overview: everything in `OverviewBody` that comes from the Findings. */
export type FindingsOverview = Pick<
  OverviewBody,
  "last_scan_at" | "has_findings" | "open_at_start" | "open_now" | "fix_rate"
>;

/**
 * The Team's latest Scan (Spot runs don't count), whether it has any Finding at all, its Open Findings at the start of
 * the last `days` days and now, and the Fix rate over them: `of` is each Finding Open at the start, or opened or
 * reopened since, once; `fixed` is those of them that moved into Fixed since and are Fixed now, with no Unconfirmed
 * fix. A Finding merged into another counts in neither. The start is the database's clock less `days`, the clock
 * history rows are written by.
 */
export async function readOverview(
  tx: Transaction<Database>,
  team: string,
  days: number,
): Promise<FindingsOverview> {
  const { rows } = await sql<{
    has_findings: boolean;
    open_at_start: string;
    open_now: string;
    of: string;
    fixed: string;
    last_scan_at: Date | null;
  }>`
    with period as (
      select clock_timestamp() - make_interval(days => ${days}::int) as since
    ),
    at_start as (
      select distinct on (h.finding_id) h.finding_id, h.status_after
        from finding_history h, period
       where h.team_id = ${team} and h.at <= period.since
       order by h.finding_id, h.at desc, h.id desc
    ),
    open_at_start as (
      select finding_id from at_start where status_after = 'open'
    ),
    opened_during as (
      select h.finding_id from finding_history h, period
       where h.team_id = ${team} and h.at > period.since
         and h.status_after = 'open' and h.status_before is distinct from 'open'
    ),
    counted as (
      select c.finding_id
        from (select finding_id from open_at_start
               union
              select finding_id from opened_during) c
        join findings f on f.team_id = ${team} and f.id = c.finding_id
       where f.moved_to is null
    ),
    fixed_during as (
      select distinct h.finding_id from finding_history h, period
       where h.team_id = ${team} and h.at > period.since
         and h.status_after = 'fixed' and h.status_before is distinct from 'fixed'
    )
    select
      exists (select 1 from findings where team_id = ${team}) as has_findings,
      (select count(*) from open_at_start) as open_at_start,
      (select count(*) from findings where team_id = ${team} and status = 'open') as open_now,
      (select count(*) from counted) as of,
      (select count(*)
         from counted c
         join fixed_during d on d.finding_id = c.finding_id
         join findings f on f.team_id = ${team} and f.id = c.finding_id
        where f.status = 'fixed' and f.unconfirmed_fix is null) as fixed,
      (select max(started_at) from scans where team_id = ${team} and kind = 'scan') as last_scan_at
  `.execute(tx);
  const row = rows[0]!;
  return {
    last_scan_at: row.last_scan_at === null ? null : isoDateTime(row.last_scan_at),
    has_findings: row.has_findings,
    open_at_start: Number(row.open_at_start),
    open_now: Number(row.open_now),
    fix_rate: { fixed: Number(row.fixed), of: Number(row.of) },
  };
}
