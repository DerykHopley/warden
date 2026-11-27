-- One Judge run per Agent session at a time (spec #225, slice 7a, #444's verifier): a run claims its session before it
-- reads the events, until `judging_until`, so two `SessionEnd`s sent together make one paid call, not two. The run
-- clears it when it marks the session judged, fails or is limited; a run that dies without clearing it frees the
-- session when the claim runs out. Null: no run holds the session.
alter table agent_sessions add column judging_until timestamptz;
