-- The review log (Vouch, spec #341, slice 3, stories 4 to 7): one row per review a Lead (or an Admin) made of a judged
-- Control's Verdict, a confirm or an override, never changed. A Control's newest row is its review; comparing that row's
-- `worked_out_verdict` with the Verdict worked out now says whether it changed since review. Vouch's audit trail, kept
-- for the life of the Team. Team-owned the way `hook_tokens` is (0013): `team_id` in the key, row-level security enabled
-- and forced, one `for all` policy on the Team `withTeam` sets (ADR 0006), a statement trigger refusing every role's
-- update, delete and truncate, and those grants revoked from warden_app. Only the Vouch module's Control Reviews store
-- (server/src/modules/vouch/control-reviews.ts) writes it, through `withTeam`.
create table control_reviews (
  team_id text not null references teams (id),
  -- Orders a Team's reviews: the highest is the newest.
  id bigint generated always as identity,
  -- The Catalogues Warden has, as `team_catalogues.catalogue` (0017); each new one widens this check in its own
  -- migration.
  catalogue text not null check (catalogue in ('vda-isa-2027.1')),
  -- The Control's number in its Catalogue, such as 1.3.3.
  control_ref text not null check (control_ref ~ '^\d+(\.\d+)*$'),
  -- The Verdict the server worked out when the review was written: never not applicable, which only a review gives.
  worked_out_verdict text not null
    check (worked_out_verdict in ('evidenced', 'partly_evidenced', 'not_evidenced')),
  outcome text not null check (outcome in ('confirmed', 'overridden')),
  -- The reviewed Verdict: the worked-out one on a confirm, the reviewer's on an override.
  verdict text not null
    check (verdict in ('evidenced', 'partly_evidenced', 'not_evidenced', 'not_applicable')),
  -- Why: required on an override, optional on a confirm, never blank.
  reason text check (reason ~ '\S'),
  -- Who reviewed: a Lead's or an Admin's Clerk user id.
  reviewed_by text not null check (reviewed_by ~ '\S'),
  reviewed_at timestamptz not null default now(),
  primary key (team_id, id),
  constraint control_reviews_override_reason check (outcome = 'confirmed' or reason is not null),
  -- A confirm keeps the worked-out Verdict; an override changes it.
  constraint control_reviews_outcome_matches
    check ((outcome = 'confirmed') = (verdict = worked_out_verdict))
);

alter table control_reviews enable row level security;
alter table control_reviews force row level security;

-- `for all` stays, so findUnprotectedTables sees a Team policy per command; the trigger and the grants below are
-- what refuse an update or a delete.
create policy control_reviews_own_team on control_reviews for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

-- As for role_history (0004): the trigger refuses every role's update, delete and truncate, warden_migrate's included.
-- warden_migrate owns the table, so it could disable or drop the trigger: that residual risk is held by whoever holds
-- the migration credentials (threat D6).
create function control_reviews_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'control_reviews is append-only: % is refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Per statement, so it fires even when row-level security hides every row the statement aims at.
create trigger control_reviews_append_only
  before update or delete or truncate on control_reviews
  for each statement execute function control_reviews_append_only();

revoke update, delete, truncate on control_reviews from warden_app;
