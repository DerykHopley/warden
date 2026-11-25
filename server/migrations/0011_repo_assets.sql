-- A Team's GitHub installations and the repos each lists, as Repo Assets (Guard spec, stories 1 and 15). A Guard Scan
-- names only the Team's Repo Assets. Team-owned the way `scan_requests` is: `team_id` in every key, row-level security
-- enabled and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006). Only the Guard module's Repo Assets
-- store (server/src/modules/guard/repo-assets.ts) writes them, through `withTeam`. No repo content and no GitHub token.

-- One row per linked installation. An installation belongs to one Team only (threat G6): the unique key on its id holds
-- across every Team, which row-level security can't hide, so a second Team's link of it fails on that constraint.
create table github_installations (
  team_id text not null references teams (id),
  -- GitHub's installation id.
  installation_id bigint not null check (installation_id > 0),
  -- Who linked it: an Admin's Clerk user id.
  linked_by text not null check (linked_by ~ '\S'),
  linked_at timestamptz not null default now(),
  primary key (team_id, installation_id),
  constraint github_installations_one_team unique (installation_id)
);

alter table github_installations enable row level security;
alter table github_installations force row level security;

create policy github_installations_own_team on github_installations for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- One row per repo per Team, named by GitHub's `html_url` (`https://github.com/<owner>/<name>`), as a Repo Asset's ref.
-- Deleting an installation's row deletes its repos.
create table repo_assets (
  team_id text not null,
  ref text not null check (ref ~ '^https://github\.com/[^/\s]+/[^/\s]+$'),
  -- GitHub's repo id.
  github_id bigint not null check (github_id > 0),
  installation_id bigint not null,
  listed_at timestamptz not null default now(),
  primary key (team_id, ref),
  foreign key (team_id, installation_id)
    references github_installations (team_id, installation_id) on delete cascade
);

-- A relink replaces one installation's repos.
create index repo_assets_by_installation on repo_assets (team_id, installation_id);

alter table repo_assets enable row level security;
alter table repo_assets force row level security;

create policy repo_assets_own_team on repo_assets for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
