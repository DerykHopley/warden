// The numbers behind the Overview's trend (story 10), read from the Findings and their history inside one `withTeam`
// transaction. No table of its own: a Finding's Status at any time is its latest history row written by then.
import type { OverviewBody } from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import { isoDateTime } from "./rows.ts";

/** What the Findings module answers for the Overview: everything in `OverviewBody` that comes from the Findings. */
export type FindingsOverview = Pick<
  OverviewBody,
  "last_scan_at" | "open_at_start" | "open_now" | "fix_rate"
>;

/**
 * The Team's latest Scan (Spot runs don't count), its Open Findings at `since` and now, and the Fix rate from `since`
 * to now: `of` is each Finding Open at `since`, or opened or reopened after it, once; `fixed` is those of them that
 * moved into Fixed after `since` and are Fixed now, with no Unconfirmed fix and not merged into another.
 */
export async function readOverview(
  tx: Transaction<Database>,
  team: string,
  since: Date,
): Promise<FindingsOverview> {
  const { rows } = await sql<{
    open_at_start: string;
    open_now: string;
    of: string;
    fixed: string;
    last_scan_at: Date | null;
  }>`
    with at_start as (
      select distinct on (finding_id) finding_id, status_after
        from finding_history
       where team_id = ${team} and at <= ${since}
       order by finding_id, at desc, id desc
    ),
    open_at_start as (
      select finding_id from at_start where status_after = 'open'
    ),
    opened_during as (
      select finding_id from finding_history
       where team_id = ${team} and at > ${since}
         and status_after = 'open' and status_before is distinct from 'open'
    ),
    counted as (
      select finding_id from open_at_start
       union
      select finding_id from opened_during
    ),
    fixed_during as (
      select distinct finding_id from finding_history
       where team_id = ${team} and at > ${since}
         and status_after = 'fixed' and status_before is distinct from 'fixed'
    )
    select
      (select count(*) from open_at_start) as open_at_start,
      (select count(*) from findings where team_id = ${team} and status = 'open') as open_now,
      (select count(*) from counted) as of,
      (select count(*)
         from counted c
         join fixed_during d on d.finding_id = c.finding_id
         join findings f on f.team_id = ${team} and f.id = c.finding_id
        where f.status = 'fixed' and f.unconfirmed_fix is null and f.moved_to is null) as fixed,
      (select max(started_at) from scans where team_id = ${team} and kind = 'scan') as last_scan_at
  `.execute(tx);
  const row = rows[0]!;
  return {
    last_scan_at: row.last_scan_at === null ? null : isoDateTime(row.last_scan_at),
    open_at_start: Number(row.open_at_start),
    open_now: Number(row.open_now),
    fix_rate: { fixed: Number(row.fixed), of: Number(row.of) },
  };
}
