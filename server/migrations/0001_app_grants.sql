-- Every table warden_migrate creates from here on grants warden_app its rows' reads and writes, and the sequences
-- behind serial keys; row-level security decides which rows. warden_admin may read them, for the deliberate
-- cross-Team totals (ADR 0006), and change nothing. Kysely's own tables were made before this, so warden_app has
-- no grant on them; the revoke keeps it that way however they were made.
alter default privileges for role warden_migrate in schema public
  grant select, insert, update, delete on tables to warden_app;

alter default privileges for role warden_migrate in schema public
  grant usage, select on sequences to warden_app;

alter default privileges for role warden_migrate in schema public
  grant select on tables to warden_admin;

revoke all on table kysely_migration, kysely_migration_lock from warden_app;
