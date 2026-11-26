-- A Team's Catalogues (Vouch, spec #341, story 1): one row per Team and Catalogue it has set, on or off, with who set
-- it and when. A Team with no row has the Catalogue off. A change replaces the row: turning one on or off keeps no
-- history, as the Privacy tier (0014) does; the review log is Vouch's audit trail. Team-owned the way `guard_settings`
-- is: `team_id` in the key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets
-- (ADR 0006). Only the Vouch module's Team Catalogues store (server/src/modules/vouch/team-catalogues.ts) writes it,
-- through `withTeam`. The Catalogue's text isn't here: it ships with Warden, the same for every Team.
create table team_catalogues (
  team_id text not null references teams (id),
  -- The Catalogues Warden has; each new one widens this check in its own migration.
  catalogue text not null check (catalogue in ('vda-isa-2027.1')),
  turned_on boolean not null,
  -- Who set it: an Admin's Clerk user id.
  set_by text not null check (set_by ~ '\S'),
  set_at timestamptz not null default now(),
  primary key (team_id, catalogue)
);

alter table team_catalogues enable row level security;
alter table team_catalogues force row level security;

create policy team_catalogues_own_team on team_catalogues for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
