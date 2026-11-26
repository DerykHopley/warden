-- A Team's write grants (#224, stories 5 and 15): the installations of Warden's write GitHub app, which Fix PRs go
-- through, that an Admin granted, kept as one row per event. Team-owned the way `github_installations` is: `team_id`
-- in every key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006).
-- Only the Guard module's write-grants store (server/src/modules/guard/write-grants.ts) writes them, through `withTeam`.
-- No GitHub token is stored.

-- The Team that holds each write-app installation: one row per installation, written on its first grant. Its key on the
-- installation's id holds across every Team, which row-level security can't hide, and every grant row points at it by
-- (team_id, installation_id), so a row naming an installation another Team holds fails (threat G6), as
-- `github_installations_one_team` does for the read app. A grant row can't carry that key itself: one Team writes
-- several rows for one installation. Never changed: the installation stays the Team's after a `revoked` row too.
create table github_write_installations (
  -- GitHub's installation id, of the write app.
  installation_id bigint primary key check (installation_id > 0),
  team_id text not null references teams (id),
  unique (team_id, installation_id)
);

alter table github_write_installations enable row level security;
alter table github_write_installations force row level security;

create policy github_write_installations_own_team on github_write_installations for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

revoke update, delete, truncate on github_write_installations from warden_app;

-- One row per event on a Team's write grant, never edited: `granted` when an Admin grants the write app on an
-- installation, `revoked` when the grant is gone (slice 2 writes it). The newest row per installation, by `id`, says
-- whether the grant holds.
create table github_write_grants (
  team_id text not null references teams (id),
  id bigint generated always as identity,
  installation_id bigint not null check (installation_id > 0),
  event text not null check (event in ('granted', 'revoked')),
  -- Who caused it: a Clerk user id (for `revoked`, the person whose request found the installation gone).
  caused_by text not null check (caused_by ~ '\S'),
  at timestamptz not null default now(),
  primary key (team_id, id),
  constraint github_write_grants_one_team foreign key (team_id, installation_id)
    references github_write_installations (team_id, installation_id)
);

-- The newest row per installation, which the store reads.
create index github_write_grants_by_installation on github_write_grants (team_id, installation_id, id);

alter table github_write_grants enable row level security;
alter table github_write_grants force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are what
-- refuse an update or a delete.
create policy github_write_grants_own_team on github_write_grants for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- The trigger refuses every role's update, delete and truncate, warden_migrate's included, as `finding_history`'s does.
-- warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by whoever holds
-- the migration credentials (threat D6). Team deletion, when it's planned, needs one marked way past this.
create function github_write_grants_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'github_write_grants is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger github_write_grants_append_only
  before update or delete or truncate on github_write_grants
  for each statement execute function github_write_grants_append_only();

revoke update, delete, truncate on github_write_grants from warden_app;
