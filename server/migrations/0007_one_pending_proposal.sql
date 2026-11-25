-- A Finding takes one pending Proposal at a time (#87): the server refuses a second with ProposalPending, and the
-- partial unique index below refuses one that gets past that check. Proposals stored before the rule may already hold
-- several pending ones on a Finding; this migration decides none of them and deletes none. It marks each later one
-- `duplicate_of` the earliest (by requested_at, then id), so the index counts only the earliest, and every one of
-- them stays pending for a Lead to approve or reject as before. Only this migration sets `duplicate_of`.

-- Same-Team: the key carries team_id, as every key on a Team table does (ADR 0006).
alter table proposals add column duplicate_of text;

alter table proposals
  add constraint proposals_duplicate_of_fkey
  foreign key (team_id, duplicate_of) references proposals (team_id, id);

alter table proposals
  add constraint proposals_duplicate_of_check check (duplicate_of <> id);

-- The backfill reads and marks every Team's rows, so row-level security is lifted for the owner, warden_migrate, for
-- this one statement and forced again straight after, in this file's transaction: no other session sees it lifted.
-- 0006's trigger lets a pending row's duplicate_of change (it doesn't list the column yet); decided rows aren't touched.
alter table proposals no force row level security;

update proposals as later
set duplicate_of = earliest.id
from (
  select distinct on (team_id, finding_id) team_id, finding_id, id
  from proposals
  where state = 'pending'
  order by team_id, finding_id, requested_at, id
) as earliest
where later.state = 'pending'
  and later.team_id = earliest.team_id
  and later.finding_id = earliest.finding_id
  and later.id <> earliest.id;

alter table proposals force row level security;

create unique index proposals_one_pending on proposals (team_id, finding_id)
  where state = 'pending' and duplicate_of is null;

-- 0006's rule, with duplicate_of among the columns a pending row may not change: deciding a marked duplicate keeps
-- its mark, and nobody clears or sets one after this migration.
create or replace function proposals_decided_once() returns trigger
  language plpgsql as $$
begin
  if old.state = 'pending'
     and (new.team_id, new.id, new.finding_id, new.decision, new.reason, new.accepted_until,
          new.requested_by_kind, new.requested_by_id, new.requested_at, new.duplicate_of)
         is not distinct from
         (old.team_id, old.id, old.finding_id, old.decision, old.reason, old.accepted_until,
          old.requested_by_kind, old.requested_by_id, old.requested_at, old.duplicate_of) then
    return new;
  end if;
  raise exception 'a Proposal is decided once, then kept as it is: this update of % is refused', old.id
    using errcode = 'insufficient_privilege';
end;
$$;

-- A new Proposal is never a marked duplicate: a second pending one is refused, not marked.
create function proposals_unmarked_insert() returns trigger
  language plpgsql as $$
begin
  if new.duplicate_of is not null then
    raise exception 'only 0007_one_pending_proposal marks a Proposal a duplicate: this insert of % is refused', new.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger proposals_unmarked_insert
  before insert on proposals
  for each row execute function proposals_unmarked_insert();
