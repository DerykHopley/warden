-- A Team's Guard settings (Guard spec, story 7): one row per Team, today its Privacy tier, who set it and when. A Team
-- with no row is at `details`, the default (GLOSSARY "Privacy tier"). A change replaces the row: tier changes keep no
-- history. Team-owned the way `hook_tokens` and `repo_assets` are: `team_id` in the key, row-level security enabled
-- and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006). Only the Guard module's hook settings store
-- (server/src/modules/guard/hook-settings.ts) writes it, through `withTeam`.
create table guard_settings (
  team_id text not null references teams (id),
  -- How much of an Agent session's content the hook sends, lowest first: metadata, details, content.
  privacy_tier text not null check (privacy_tier in ('metadata', 'details', 'content')),
  -- Who set it: an Admin's Clerk user id.
  set_by text not null check (set_by ~ '\S'),
  set_at timestamptz not null default now(),
  primary key (team_id)
);

alter table guard_settings enable row level security;
alter table guard_settings force row level security;

create policy guard_settings_own_team on guard_settings for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
