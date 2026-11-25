-- Each person's Role in a Team, and the history of every Role change (ADR 0008: Warden keeps Roles, Clerk keeps
-- identity). Both are Team-owned the way `findings` is: `team_id` in every key, row-level security enabled and
-- forced, one `for all` policy on the Team `withTeam` sets (ADR 0006). Only the members module
-- (server/src/members.ts) writes them, through `withTeam`. No names or emails: the dashboard reads those from Clerk.

-- One row per person in a Team, keyed by their Clerk user id. Member < Lead < Admin, each including the one below.
create table team_members (
  team_id text not null references teams (id),
  user_id text not null check (user_id !~ '^\s*$'),
  role text not null check (role in ('member', 'lead', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

alter table team_members enable row level security;
alter table team_members force row level security;

create policy team_members_own_team on team_members for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- One row per Role change: who (user_id) went from which Role to which, by whose hand (actor_id), and when. Never
-- edited. No foreign key to team_members, so the history outlives a membership (#29 removes people who leave).
-- `created_team` and `joined` are written on a person's first visit (role_before null); `changed` from #30.
create table role_history (
  team_id text not null references teams (id),
  id bigint generated always as identity,
  user_id text not null check (user_id !~ '^\s*$'),
  role_before text check (role_before in ('member', 'lead', 'admin')),
  role_after text not null check (role_after in ('member', 'lead', 'admin')),
  change text not null check (change in ('created_team', 'joined', 'changed')),
  actor_id text not null check (actor_id !~ '^\s*$'),
  at timestamptz not null default now(),
  primary key (team_id, id)
);

alter table role_history enable row level security;
alter table role_history force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are
-- what refuse an update or a delete.
create policy role_history_own_team on role_history for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- As for finding_history (0003): the trigger refuses every role's update, delete and truncate, warden_migrate's
-- included. warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by
-- whoever holds the migration credentials (threat D6).
create function role_history_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'role_history is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger role_history_append_only
  before update or delete or truncate on role_history
  for each statement execute function role_history_append_only();

revoke update, delete, truncate on role_history from warden_app;
