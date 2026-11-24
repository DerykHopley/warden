-- Proposals (ADR 0005, ADR 0008): a decision an agent or a Member suggests, which a Lead approves or rejects. Each
-- keeps who asked and who decided, so a later four-eyes rule needs no data change. Team-owned the way `findings` is:
-- `team_id` in every key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets
-- (ADR 0006). Only the Findings module (server/src/findings) writes it, through `withTeam`.
create table proposals (
  team_id text not null references teams (id),
  id text not null check (id ~ '\S'),
  finding_id text not null,
  decision text not null check (decision in ('accept', 'mark_false_positive')),
  reason text not null check (reason ~ '\S'),
  accepted_until timestamptz,
  -- Who asked: the glossary's Actor, a person (a Clerk user id) or an agent (its id).
  requested_by_kind text not null check (requested_by_kind in ('person', 'agent')),
  requested_by_id text not null check (requested_by_id ~ '\S'),
  requested_at timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected')),
  -- Who decided: always a person, a Lead.
  decided_by text check (decided_by ~ '\S'),
  decided_at timestamptz,
  decided_reason text,
  primary key (team_id, id),
  foreign key (team_id, finding_id) references findings (team_id, id),
  constraint proposals_until_check check ((decision = 'accept') = (accepted_until is not null)),
  constraint proposals_decided_check check (
    (state = 'pending') = (decided_by is null) and (state = 'pending') = (decided_at is null)
  ),
  constraint proposals_decided_reason_check check (
    case
      when state = 'rejected' then decided_reason is not null and decided_reason ~ '\S'
      else decided_reason is null
    end
  )
);

create index proposals_by_finding on proposals (team_id, finding_id);

alter table proposals enable row level security;
alter table proposals force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the triggers and the grants below are
-- what refuse a delete or a second decision.
create policy proposals_own_team on proposals for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- A Proposal is decided once and then kept as it is: the one update allowed takes a pending row's state and decided_*
-- columns, and nothing else. As for finding_history (0003), the triggers bind every role, warden_migrate's included;
-- it owns the table, so it could drop them: that residual risk is held by whoever holds the migration credentials
-- (threat D6).
create function proposals_decided_once() returns trigger
  language plpgsql as $$
begin
  if old.state = 'pending'
     and (new.team_id, new.id, new.finding_id, new.decision, new.reason, new.accepted_until,
          new.requested_by_kind, new.requested_by_id, new.requested_at)
         is not distinct from
         (old.team_id, old.id, old.finding_id, old.decision, old.reason, old.accepted_until,
          old.requested_by_kind, old.requested_by_id, old.requested_at) then
    return new;
  end if;
  raise exception 'a Proposal is decided once, then kept as it is: this update of % is refused', old.id
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger proposals_decided_once
  before update on proposals
  for each row execute function proposals_decided_once();

create function proposals_kept() returns trigger
  language plpgsql as $$
begin
  raise exception 'proposals keeps every Proposal: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger proposals_kept
  before delete or truncate on proposals
  for each statement execute function proposals_kept();

revoke delete, truncate on proposals from warden_app;

-- finding_history: the daily Job reopens an expired acceptance, and a person's decision that approved a Proposal
-- names it. The append-only trigger fires on row changes, not on `alter table`; the new column has no default, so no
-- row is rewritten.
alter table finding_history drop constraint finding_history_actor_kind_check;

alter table finding_history
  add constraint finding_history_actor_kind_check
  check (actor_kind in ('scan', 'spot_run', 'person', 'job'));

alter table finding_history add column proposal_id text;

alter table finding_history
  add constraint finding_history_proposal_fkey
  foreign key (team_id, proposal_id) references proposals (team_id, id);

alter table finding_history
  add constraint finding_history_proposal_check
  check (proposal_id is null or actor_kind = 'person');

-- warden_admin (the owner's answer on #35, ADR 0009): no BYPASSRLS anywhere (`pnpm roles`), and one permissive policy
-- that lets it list Team ids, for the daily Job, which then changes each Team through `withTeam`. Only the id column:
-- its table-wide select (0001's default privileges) goes. It reads no row of any other table: forced row-level
-- security, whose only policies are the Team ones, and no Team is set in `withAdmin`.
create policy teams_admin_lists_ids on teams for select to warden_admin using (true);

revoke select on teams from warden_admin;

grant select (id) on teams to warden_admin;
