-- A repo stays one of the Team's Repo Assets while any of the Team's GitHub installations lists it (#158). Under
-- 0011_repo_assets a repo had one row per Team, naming one installation, so relinking that installation without the
-- repo dropped it although another installation still listed it. From here `repo_assets` holds one row per Team,
-- installation and ref: each installation's link rewrites only its own rows, and the Repo Assets store reads a repo
-- several installations list as one Repo Asset, under the one that listed it latest (ties: the larger installation id).
-- Every row 0011 wrote is kept as it is: each is already one row per installation and ref. Row-level security, the
-- policy and the foreign key to `github_installations` are unchanged.

alter table repo_assets drop constraint repo_assets_pkey;

alter table repo_assets add primary key (team_id, installation_id, ref);

-- The key now leads with (team_id, installation_id), which a relink's delete reads, so 0011's index for it goes. A
-- Guard Scan's check and the listing read a Team's rows by ref instead.
drop index repo_assets_by_installation;

create index repo_assets_by_ref on repo_assets (team_id, ref);
