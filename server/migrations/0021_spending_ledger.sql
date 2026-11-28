-- A Team's spending ledger (spec #225, slice 7a, story 10, threat J5): one row per paid model call Warden makes for
-- the Team, whatever it answered, so the per-Team daily limit counts every call. It holds no content and no person:
-- the spending path, the model's name, the tokens and the cost. Team-owned the way `agent_sessions` is: `team_id` in
-- every key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006).
-- Append-only the way `fix_prs` is. Only the shared spending store (server/src/spending.ts) writes it, through
-- `withTeam`.
--
-- A call's cost is reserved before the call: under a per-Team advisory lock, the store sums today's rows and, below the
-- limit, adds a row at the assumed cost, so overlapping runs of one Team can't each pass the check. After the answer,
-- a correction row (`corrects` set) adds the difference to the cost the answer stated, or takes the assumed cost back
-- for a call the provider refused unbilled. A call that timed out or failed upstream keeps its reservation.
create table spending_ledger (
  team_id text not null references teams (id),
  id bigint generated always as identity,
  at timestamptz not null default now(),
  -- What made the call: the Judge today; Scans and chat add theirs when they make paid calls.
  path text not null check (path in ('judge')),
  -- The model's name, as the call sent it.
  model text not null check (model ~ '\S'),
  -- The tokens the provider's answer stated; null when it stated none (a reservation, a failed call, or an answer
  -- without them).
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  -- The call's cost in US dollars: the provider's stated cost, or the assumed cost of an unpriced call. On a
  -- correction, the difference from its reservation, below 0 when the call cost less.
  cost_usd numeric not null,
  -- 'unbilled' only on a correction: the provider refused the call before it ran (a 4xx), so it cost nothing.
  cost_basis text not null check (cost_basis in ('stated', 'assumed', 'unbilled')),
  -- The reservation this row corrects, at most once; null on a reservation or a call recorded at its known cost.
  corrects bigint,
  primary key (team_id, id),
  unique (team_id, corrects),
  foreign key (team_id, corrects) references spending_ledger (team_id, id),
  check (cost_usd >= 0 or corrects is not null),
  check (cost_basis <> 'unbilled' or corrects is not null)
);

-- Today's spending, which the limit reads before each paid call.
create index spending_ledger_by_day on spending_ledger (team_id, at);

alter table spending_ledger enable row level security;
alter table spending_ledger force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are what
-- refuse an update or a delete.
create policy spending_ledger_own_team on spending_ledger for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- The trigger refuses every role's update, delete and truncate, warden_migrate's included, as `fix_prs`'s does.
-- warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by whoever holds
-- the migration credentials (threat D6). Team deletion, when it's planned, needs one marked way past this.
create function spending_ledger_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'spending_ledger is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger spending_ledger_append_only
  before update or delete or truncate on spending_ledger
  for each statement execute function spending_ledger_append_only();

revoke update, delete, truncate on spending_ledger from warden_app;
