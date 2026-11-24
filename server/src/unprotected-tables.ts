// The CI check behind ADR 0006: row-level security moves the risk from every query to every new table, so every
// table in `public` must keep Teams apart. A server test runs this on a freshly migrated database and expects an
// empty list, so a migration that adds a table without its policies fails the fast lane, naming the table.
import type pg from "pg";

/** Tables in `public` that aren't Team data, each with why. Anything not named here counts as Team-owned. */
const NOT_TEAM_DATA: Record<string, string> = {
  kysely_migration:
    "Kysely's record of applied migrations; 0001_app_grants revokes warden_app's access",
  kysely_migration_lock: "Kysely's migration lock; 0001_app_grants revokes warden_app's access",
};

// Protected: row-level security enabled and forced (so the owner is bound too), with a Team policy covering each of
// select, insert, update and delete; a `for all` policy covers all four. A Team policy applies to warden_app (or to
// everyone, `public`), and each expression it has (`using`, `with check`) reads the Team withTeam sets. That is read
// from the policy's text, so it catches `using (true)` and a policy for another role, not a wrong comparison.
//
// Tables, partitioned tables, materialized views and foreign tables all hold rows. Row-level security doesn't apply to
// a materialized view, so one is always named: Team data has no place in one.
const UNPROTECTED_SQL = `
with team_policy as (
  select p.tablename, p.cmd
    from pg_policies p
   where p.schemaname = 'public'
     and p.roles && array['public', 'warden_app']::name[]
     and (p.qual is not null or p.with_check is not null)
     and (p.qual is null or strpos(p.qual, 'current_setting(''warden.team_id''') > 0)
     and (p.with_check is null or strpos(p.with_check, 'current_setting(''warden.team_id''') > 0)
)
select c.relname as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'm', 'f')
   and (not c.relrowsecurity
        or not c.relforcerowsecurity
        or exists (
          select from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as command (cmd)
           where not exists (
             select from team_policy p where p.tablename = c.relname and p.cmd in (command.cmd, 'ALL')
           )
        ))
 order by c.relname
`;

/** The name of each table in `public` that lacks row-level security, forced, with a Team policy per command. */
export async function findUnprotectedTables(pool: Pick<pg.Pool, "query">): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(UNPROTECTED_SQL);
  return rows.map((row) => row.name).filter((name) => !Object.hasOwn(NOT_TEAM_DATA, name));
}
