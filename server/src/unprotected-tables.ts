// The CI check behind ADR 0006: row-level security moves the risk from every query to every new table, so every
// table must keep Teams apart. A server test runs this on a freshly migrated database and expects an empty list, so
// a migration that adds a table without its policies fails the fast lane, naming the table.
import type pg from "pg";
import { DATABASE_ROLE_NAMES, PREVIEW_DATABASE_ROLE_NAMES } from "./database.ts";

/** Tables in `public` that aren't Team data, each with why. Anything not named here counts as Team-owned. */
const NOT_TEAM_DATA: Record<string, string> = {
  kysely_migration:
    "Kysely's record of applied migrations; 0001_app_grants revokes warden_app's access",
  kysely_migration_lock: "Kysely's migration lock; 0001_app_grants revokes warden_app's access",
};

// Protected: row-level security enabled and forced (so the owner is bound too), with a Team policy covering each of
// select, insert, update and delete; a `for all` policy covers all four. A Team policy applies to an app role
// (warden_app or warden_preview_app, a role either is a member of, or everyone: `public`), and each expression it has (`using`, `with check`) reads the Team withTeam sets. That is read
// from the policy's text, so it catches `using (true)` and a policy for another role, not a wrong comparison.
//
// Postgres ORs a table's permissive policies together, so one permissive policy for warden_app (or `public`) that
// doesn't read the Team opens every Team's rows, whatever Team policy sits beside it: such a table is named too. A
// restrictive policy is ANDed, so it can only narrow access, and isn't.
//
// Every table Warden ships lives in `public`, so a table in any other schema is named, schema-qualified: no Team
// policy is looked for there. The system schemas and each session's own temporary schemas aren't Warden's.
//
// Tables, partitioned tables, materialized views and foreign tables all hold rows. Row-level security doesn't apply to
// a materialized view, so one is always named: Team data has no place in one.
//
// A policy for a role the app role is a member of, directly or indirectly, applies to the app role too, so it counts
// like one for the app role itself. $1 is the app roles' names: the live set's and the preview set's.
const UNPROTECTED_SQL = `
with recursive app_role (oid) as (
  select oid from pg_roles where rolname = any($1)
  union
  select m.roleid from pg_auth_members m join app_role a on m.member = a.oid
),
app_policy as (
  select p.tablename, p.cmd, p.permissive,
         (p.qual is not null or p.with_check is not null)
           and (p.qual is null or strpos(p.qual, 'current_setting(''warden.team_id''') > 0)
           and (p.with_check is null or strpos(p.with_check, 'current_setting(''warden.team_id''') > 0)
           as reads_team
    from pg_policies p
   where p.schemaname = 'public'
     and p.roles && (array['public']::name[]
                     || array(select r.rolname from pg_roles r join app_role a on a.oid = r.oid))
)
select case when n.nspname = 'public' then c.relname else n.nspname || '.' || c.relname end as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p', 'm', 'f')
   and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   and n.nspname !~ '^pg_(toast_)?temp_'
   and (n.nspname <> 'public'
        or not c.relrowsecurity
        or not c.relforcerowsecurity
        or exists (
          select from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as command (cmd)
           where not exists (
             select from app_policy p
              where p.tablename = c.relname and p.reads_team and p.cmd in (command.cmd, 'ALL')
           )
        )
        or exists (
          select from app_policy p
           where p.tablename = c.relname and p.permissive = 'PERMISSIVE' and not p.reads_team
        ))
 order by 1
`;

/**
 * The name of each table that lacks row-level security, forced, with a Team policy per command and no permissive
 * policy that skips the Team; and of each table outside `public`, as `schema.table`.
 */
export async function findUnprotectedTables(pool: Pick<pg.Pool, "query">): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(UNPROTECTED_SQL, [
    [DATABASE_ROLE_NAMES.app, PREVIEW_DATABASE_ROLE_NAMES.app],
  ]);
  return rows.map((row) => row.name).filter((name) => !Object.hasOwn(NOT_TEAM_DATA, name));
}
