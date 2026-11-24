-- Findings, the Scans that reconciled them, and their Status history (ADR 0005), each Team-owned the way `teams` is:
-- `team_id` in every key, row-level security enabled and forced, one `for all` policy on the Team `withTeam` sets
-- (ADR 0006). Only the Findings module (server/src/findings) writes them, through `withTeam`.

-- One row per Finding, every Finding v1 field. The fields the Findings page filters on are columns; the nested ones
-- are jsonb. first_seen_scan and last_seen_scan are plain ids: a Finding may name a Scan no one stored.
create table findings (
  team_id text not null references teams (id),
  id text not null check (id !~ '^\s*$'),
  asset_kind text not null check (asset_kind in ('repo', 'product', 'device', 'agent_session')),
  asset_ref text not null,
  module text not null check (module in ('guard', 'patch', 'vouch')),
  rule_id text not null,
  fingerprint text not null,
  location jsonb not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  title text not null,
  evidence jsonb not null,
  control jsonb,
  status text not null check (status in ('open', 'fixed', 'accepted', 'false_positive')),
  unconfirmed_fix jsonb,
  accepted_reason text,
  accepted_until timestamptz,
  first_seen_scan text not null,
  last_seen_scan text not null,
  moved_to text,
  primary key (team_id, id),
  foreign key (team_id, moved_to) references findings (team_id, id)
);

-- One problem is one Finding: within one Asset, a Fingerprint names at most one Finding that isn't merged into another.
create unique index findings_one_per_problem
  on findings (team_id, module, asset_kind, asset_ref, fingerprint)
  where moved_to is null;

alter table findings enable row level security;
alter table findings force row level security;

create policy findings_own_team on findings for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- Every Scan and Spot run reconciled, by id: a retried one is recognised and changes nothing.
create table scans (
  team_id text not null references teams (id),
  id text not null,
  kind text not null check (kind in ('scan', 'spot_run')),
  module text not null check (module in ('guard', 'patch', 'vouch')),
  started_at timestamptz not null,
  applied_at timestamptz not null default now(),
  primary key (team_id, id)
);

alter table scans enable row level security;
alter table scans force row level security;

create policy scans_own_team on scans for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- The Asset and Rule pairs each Scan covered; a Spot run covers none. Scan order per pair reads the newest
-- started_at here: a Scan's result for a pair a later-started Scan already covered is dropped.
create table scan_coverage (
  team_id text not null,
  scan_id text not null,
  asset_kind text not null,
  asset_ref text not null,
  rule_id text not null,
  primary key (team_id, scan_id, asset_kind, asset_ref, rule_id),
  foreign key (team_id, scan_id) references scans (team_id, id)
);

create index scan_coverage_by_pair on scan_coverage (team_id, asset_kind, asset_ref, rule_id);

alter table scan_coverage enable row level security;
alter table scan_coverage force row level security;

create policy scan_coverage_own_team on scan_coverage for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- One row per change to a Finding: opened (status_before null), a Status change, or a Severity change. Never edited.
-- actor_kind and actor_id name who caused it: for now the Scan or Spot run; slice 8 adds a person and a Proposal.
create table finding_history (
  team_id text not null,
  id bigint generated always as identity,
  finding_id text not null,
  at timestamptz not null default now(),
  status_before text,
  status_after text not null,
  severity_before text,
  severity_after text not null,
  actor_kind text not null check (actor_kind in ('scan', 'spot_run')),
  actor_id text not null,
  reason text not null check (reason ~ '\S'),
  primary key (team_id, id),
  foreign key (team_id, finding_id) references findings (team_id, id)
);

create index finding_history_by_finding on finding_history (team_id, finding_id, id);

alter table finding_history enable row level security;
alter table finding_history force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are
-- what refuse an update or a delete.
create policy finding_history_own_team on finding_history for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- Append-only from every role, warden_migrate (the owner) included. Team deletion, when it's planned, needs one
-- marked way past this (see docs/data.md).
create function finding_history_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'finding_history is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger finding_history_append_only
  before update or delete or truncate on finding_history
  for each statement execute function finding_history_append_only();

revoke update, delete, truncate on finding_history from warden_app;
