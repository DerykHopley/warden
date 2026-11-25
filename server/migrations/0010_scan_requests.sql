-- Queued Scans (ADR 0009): what a Lead asked to scan, and where its Scan Job is. The Job reads the row by its id and
-- Team, which is all the starter hands it; the Rules are the module's scanner's at the time of asking. Team-owned the
-- way `findings` is: `team_id` in every key, row-level security enabled and forced, one `for all` policy on the Team
-- `withTeam` sets (ADR 0006). Only the Scans module (server/src/scans.ts) writes it, through `withTeam`. A failed Scan
-- stores no error message: the log holds it, under the Scan's id and Team.
create table scan_requests (
  team_id text not null references teams (id),
  id text not null check (id ~ '\S'),
  module text not null check (module in ('guard', 'patch', 'vouch')),
  assets jsonb not null check (jsonb_typeof(assets) = 'array' and jsonb_array_length(assets) between 1 and 100),
  rules text[] not null check (cardinality(rules) >= 1),
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  -- Who asked: a Lead's Clerk user id.
  requested_by text not null check (requested_by ~ '\S'),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  primary key (team_id, id),
  constraint scan_requests_ended_check check ((state in ('done', 'failed')) = (ended_at is not null)),
  constraint scan_requests_started_check check (state not in ('running', 'done') or started_at is not null)
);

-- The rate limit counts a Team's starts in the last hour.
create index scan_requests_by_queued on scan_requests (team_id, queued_at);

alter table scan_requests enable row level security;
alter table scan_requests force row level security;

create policy scan_requests_own_team on scan_requests for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
