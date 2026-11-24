-- The first Team-owned table, and the root every later one points at (`team_id references teams (id)`). Its id is
-- the Team's Clerk Organization id. Row-level security keeps each Team to its own rows (ADR 0006): a row is visible
-- and writable only when it belongs to the Team `withTeam` set for the transaction in `warden.team_id`. Unset, or
-- empty as it reads after such a transaction ends, that matches no row: no Team set means no rows. Forced, so the
-- owner (warden_migrate) is bound too. The grants come from 0001_app_grants.
create table teams (
  id text primary key check (id !~ '^\s*$'),
  created_at timestamptz not null default now()
);

alter table teams enable row level security;
alter table teams force row level security;

create policy teams_own_team on teams for all
  using (id = current_setting('warden.team_id', true))
  with check (id = current_setting('warden.team_id', true));
