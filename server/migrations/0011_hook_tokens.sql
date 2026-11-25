-- A Team's hook token (Guard spec, story 7; #100's question 4): one row per token issued, the first and each rotation,
-- holding the token's SHA-256 hash, never the token. The Team's newest row is its current token; the one before it
-- stays valid for 24 h after the newest was written. A row is never changed, so the table is the audit trail of
-- rotations. Team-owned the way `repo_assets` is: `team_id` in every key, row-level security enabled and forced, one
-- `for all` policy on the Team `withTeam` sets (ADR 0006). Only the Guard module's hook settings store
-- (server/src/modules/guard/hook-settings.ts) writes it, through `withTeam`; the token names its Team, so reading a
-- token's rows needs no cross-Team read.
create table hook_tokens (
  team_id text not null references teams (id),
  -- Orders a Team's tokens: the highest is the newest.
  id bigint generated always as identity,
  -- The token's SHA-256, as 64 hex digits.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Who issued it: an Admin's Clerk user id.
  issued_by text not null check (issued_by ~ '\S'),
  issued_at timestamptz not null default now(),
  primary key (team_id, id)
);

alter table hook_tokens enable row level security;
alter table hook_tokens force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are
-- what refuse an update or a delete.
create policy hook_tokens_own_team on hook_tokens for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- As for role_history (0004): the trigger refuses every role's update, delete and truncate, warden_migrate's included.
-- warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by whoever holds
-- the migration credentials (threat D6).
create function hook_tokens_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'hook_tokens is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger hook_tokens_append_only
  before update or delete or truncate on hook_tokens
  for each statement execute function hook_tokens_append_only();

revoke update, delete, truncate on hook_tokens from warden_app;
