-- A Team's own Judge model (spec #225, slice 6a, story 10): one row per Team that named one, holding its
-- OpenAI-compatible base URL and model name, who set it and when. A Team with no row is judged on OpenRouter. A change
-- replaces the row, and clearing it deletes the row: changes keep no history. Team-owned the way `guard_settings` is:
-- `team_id` in the key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets (ADR
-- 0006). Only the Guard module's Judge models store (server/src/modules/guard/judge-models.ts) writes it, through
-- `withTeam`, after the URL rule (judge-url.ts) accepted the URL.
create table judge_models (
  team_id text not null references teams (id),
  -- The base URL the Judge adds `/chat/completions` to.
  url text not null check (char_length(url) between 1 and 2048),
  -- The model name the Team's server knows, for example `qwen3.8:27b`.
  model text not null check (char_length(model) between 1 and 200 and model ~ '\S'),
  -- Who set it: an Admin's Clerk user id.
  set_by text not null check (set_by ~ '\S'),
  set_at timestamptz not null default now(),
  primary key (team_id)
);

alter table judge_models enable row level security;
alter table judge_models force row level security;

create policy judge_models_own_team on judge_models for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
