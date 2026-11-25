-- A Team's Products (Patch, spec #101): what the Team ships, its Repo URLs, and the Patch frameworks each uses.
-- Team-owned the way `proposals` is: `team_id` in every key, row-level security enabled and forced, one `for all`
-- policy on the Team `withTeam` sets (ADR 0006). Only the Patch module (server/src/modules/patch) reads and writes
-- them, through `withTeam`.

-- A Product's id is the Asset ref its Findings carry, so a rename keeps them. A name is unique in its Team whatever its
-- case and the spaces around it (the server trims a name before it writes one). A Repo URL is text only: nothing links
-- it to a Guard Repo Asset yet.
create table products (
  team_id text not null references teams (id),
  id text not null check (id ~ '\S'),
  name text not null check (name ~ '\S'),
  repo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (team_id, id)
);

create unique index products_team_name_key on products (team_id, lower(btrim(name)));

-- One row per framework per Product: two versions of one framework would share a Fingerprint, as a dependency's purl
-- carries no version. `framework` is an id from the Patch module's PATCH_FRAMEWORKS, which the server checks; `usage`
-- is the contracts' Usage. Deleting a Product deletes its rows.
create table product_dependencies (
  team_id text not null references teams (id),
  product_id text not null,
  framework text not null check (framework ~ '\S'),
  version text check (version ~ '\S'),
  usage text not null check (usage in ('self_hosted', 'library', 'transitive', 'hosted')),
  internet_facing boolean not null,
  primary key (team_id, product_id, framework),
  foreign key (team_id, product_id) references products (team_id, id) on delete cascade
);

alter table products enable row level security;
alter table products force row level security;

create policy products_own_team on products for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));

alter table product_dependencies enable row level security;
alter table product_dependencies force row level security;

create policy product_dependencies_own_team on product_dependencies for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
