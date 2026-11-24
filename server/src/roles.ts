// Warden's three database roles (ADR 0006), made by a superuser on the database it connects to, and safe to run
// again: `pnpm roles` with the PG* variables naming the superuser and the database. No passwords: compose and CI use
// trust auth, and Cloud SQL's are set from Secret Manager.
//
// - warden_migrate owns the schema and every table, and runs the migrations.
// - warden_app is what request and job code connects as: bound by row-level security, owns nothing, and is a member
//   of no other role, so it can't `set role` its way out.
// - warden_admin bypasses row-level security, for the few deliberate cross-Team tasks.
import type pg from "pg";
import { createPool } from "./database.ts";
import { createLogger } from "./log.ts";

// A role is altered only when it differs from what's wanted: roles belong to the whole server, and two runs altering
// the same role at once (the test databases are made in parallel) fail with "tuple concurrently updated".
const ROLES_SQL = `
do $$
declare
  wanted record;
  attributes text;
begin
  for wanted in
    select * from (values ('warden_migrate', false), ('warden_app', false), ('warden_admin', true)) as w (name, bypassrls)
  loop
    attributes := 'login nosuperuser nocreatedb nocreaterole '
      || case when wanted.bypassrls then 'bypassrls' else 'nobypassrls' end;
    if not exists (select from pg_roles where rolname = wanted.name) then
      execute format('create role %I %s', wanted.name, attributes);
    elsif not exists (
      select from pg_roles
       where rolname = wanted.name and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
         and rolbypassrls = wanted.bypassrls
    ) then
      execute format('alter role %I %s', wanted.name, attributes);
    end if;
  end loop;
  -- warden_app may not become the other two, however it got a membership.
  if exists (
    select from pg_auth_members m
     where m.member = 'warden_app'::regrole and m.roleid in ('warden_migrate'::regrole, 'warden_admin'::regrole)
  ) then
    revoke warden_migrate, warden_admin from warden_app;
  end if;
end
$$;
alter schema public owner to warden_migrate;
grant usage on schema public to warden_app, warden_admin;
`;

export async function createRoles(pool: Pick<pg.Pool, "query">): Promise<void> {
  await pool.query(ROLES_SQL);
}

if (import.meta.main) {
  const logger = createLogger();
  const pool = createPool(logger, { max: 1 });
  try {
    await createRoles(pool);
    logger.info("roles ready", { roles: ["warden_migrate", "warden_app", "warden_admin"] });
  } catch (error) {
    logger.error("creating the roles failed", { error });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
