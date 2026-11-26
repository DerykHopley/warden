-- A Team's Fix PRs (#224, owner answer 2): one row per PR Warden's write GitHub app opened for a Finding, never
-- edited, kept beside the Finding rather than in Finding v1. Team-owned the way `github_write_grants` is: `team_id` in
-- every key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006). Only
-- the Guard module's Fix PRs store (server/src/modules/guard/fix-prs.ts) writes them, through `withTeam`. No repo
-- content and no GitHub token is stored.
create table fix_prs (
  team_id text not null references teams (id),
  id bigint generated always as identity,
  finding_id text not null,
  -- The PR as GitHub answered it: its `html_url`, its number in the repo, and the branch it was opened from.
  url text not null,
  number integer not null check (number > 0),
  branch text not null,
  -- Who opened it: a Clerk user id.
  opened_by text not null check (opened_by ~ '\S'),
  at timestamptz not null default now(),
  primary key (team_id, id),
  -- A row names one of its own Team's Findings: the key carries the Team, so another Team's Finding id fails.
  constraint fix_prs_finding foreign key (team_id, finding_id) references findings (team_id, id),
  -- One row per PR: recording the same PR again writes nothing.
  constraint fix_prs_one_per_pr unique (team_id, finding_id, number)
);

-- The newest row per Finding, which the store reads.
create index fix_prs_by_finding on fix_prs (team_id, finding_id, id);

alter table fix_prs enable row level security;
alter table fix_prs force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are what
-- refuse an update or a delete.
create policy fix_prs_own_team on fix_prs for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- The trigger refuses every role's update, delete and truncate, warden_migrate's included, as `github_write_grants`'s
-- does. warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by whoever
-- holds the migration credentials (threat D6). Team deletion, when it's planned, needs one marked way past this.
create function fix_prs_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'fix_prs is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger fix_prs_append_only
  before update or delete or truncate on fix_prs
  for each statement execute function fix_prs_append_only();

revoke update, delete, truncate on fix_prs from warden_app;
