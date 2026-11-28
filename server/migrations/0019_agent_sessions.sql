-- A Team's Agent sessions and their Agent events (spec #225, slice 1, #183): what the hook endpoint stores from each
-- event Claude Code posts. One session row per (Team, Claude Code's session_id), holding no content; one event row per
-- stored event, holding only the fields the Team's Privacy tier keeps (the Metadata fields, in this slice). Team-owned
-- the way `guard_settings` is: `team_id` in every key, row-level security enabled and forced, one `for all` policy on
-- the Team `withTeam` sets (ADR 0006). No append-only trigger: the Judge drops judged events (slice 5) and the daily
-- job deletes old ones (slice 8). Only the Guard module's Agent sessions store
-- (server/src/modules/guard/agent-sessions.ts) writes them, through `withTeam`.
create table agent_sessions (
  team_id text not null references teams (id),
  -- Claude Code's session_id, held to the endpoint's pattern.
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- The developer's pseudonym (docs/data.md, "The pseudonym"), from the first event that carried one; null with none.
  developer text check (developer ~ '^[0-9a-f]{64}$'),
  -- The AI coding agent the session ran in.
  agent text not null check (agent in ('claude-code')),
  -- When its first event arrived, its last one, and its SessionEnd.
  started_at timestamptz not null default now(),
  last_event_at timestamptz not null default now(),
  ended_at timestamptz,
  -- When the Judge read it, and what it found: null until slice 5.
  judged_at timestamptz,
  outcome text,
  -- Events refused for the Team's rate limit (threat H6), added with the session's next stored event.
  refused_events integer not null default 0 check (refused_events >= 0),
  primary key (team_id, session_id)
);

alter table agent_sessions enable row level security;
alter table agent_sessions force row level security;

create policy agent_sessions_own_team on agent_sessions for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

create table agent_events (
  team_id text not null,
  session_id text not null,
  -- Orders the events as they were stored.
  seq bigint generated always as identity,
  received_at timestamptz not null default now(),
  -- Claude Code's hook_event_name, and its tool_name on a tool event.
  name text not null check (name ~ '\S'),
  tool text,
  -- What the Team's Privacy tier kept of the event: top-level strings only.
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  primary key (team_id, seq),
  foreign key (team_id, session_id) references agent_sessions (team_id, session_id)
);

create index agent_events_session on agent_events (team_id, session_id, seq);

alter table agent_events enable row level security;
alter table agent_events force row level security;

create policy agent_events_own_team on agent_events for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
