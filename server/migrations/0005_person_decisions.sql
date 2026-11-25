-- A person's named decisions (ADR 0005): accepting, marking a False positive, confirming a fix, marking one moved and
-- reopening each write a finding_history row naming that person. Never an agent: an agent only proposes.
-- The append-only trigger fires on row changes, not on `alter table`, so the check is dropped and added again. No
-- grant changes: warden_app already inserts into finding_history (0001's default privileges).
alter table finding_history drop constraint finding_history_actor_kind_check;

alter table finding_history
  add constraint finding_history_actor_kind_check
  check (actor_kind in ('scan', 'spot_run', 'person'));
