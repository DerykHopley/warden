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

// Protected: row-level security enabled and forced (so the owner is bound too), with a policy covering each of
// select, insert, update and delete; a `for all` policy covers all four.
const UNPROTECTED_SQL = `
select c.relname as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p')
   and (not c.relrowsecurity
        or not c.relforcerowsecurity
        or exists (
          select from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as command (cmd)
           where not exists (
             select from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname and p.cmd in (command.cmd, 'ALL')
           )
        ))
 order by c.relname
`;

/** The name of each table in `public` that lacks row-level security, forced, with a policy per command. */
export async function findUnprotectedTables(pool: Pick<pg.Pool, "query">): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(UNPROTECTED_SQL);
  return rows.map((row) => row.name).filter((name) => !Object.hasOwn(NOT_TEAM_DATA, name));
}
