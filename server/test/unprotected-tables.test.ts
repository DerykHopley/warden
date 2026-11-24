// The CI check (ADR 0006): every table Warden ships keeps Teams apart, and a table that doesn't is named. Each case
// gets a fresh database: the grants test adds an unprotected table to the suite's shared one while it runs.
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { findUnprotectedTables } from "../src/unprotected-tables.ts";
import { createMigratedTestDatabase, poolAs, testName } from "./databases.ts";

const silent = createLogger(() => {});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh database with every shipped migration, and a pool on it as warden_migrate. */
async function migratedDatabase(): Promise<{ name: string; pool: pg.Pool }> {
  const database = await createMigratedTestDatabase();
  cleanups.push(database.drop);
  const pool = poolAs("warden_migrate", database.name);
  cleanups.push(() => pool.end());
  return { name: database.name, pool };
}

describe("findUnprotectedTables", () => {
  it("finds no unprotected table after every shipped migration", async () => {
    const { pool } = await migratedDatabase();

    expect(await findUnprotectedTables(pool)).toEqual([]);
  });

  it("names a table whose policies don't keep warden_app to the Team, or that aren't there", async () => {
    const { pool } = await migratedDatabase();
    await pool.query(`
      create table no_rls (team_id text);

      create table not_forced (team_id text);
      alter table not_forced enable row level security;
      create policy not_forced_team on not_forced for all
        using (team_id = current_setting('warden.team_id', true));

      create table no_write_policy (team_id text);
      alter table no_write_policy enable row level security;
      alter table no_write_policy force row level security;
      create policy no_write_policy_read on no_write_policy for select
        using (team_id = current_setting('warden.team_id', true));
      create policy no_write_policy_insert on no_write_policy for insert
        with check (team_id = current_setting('warden.team_id', true));
      create policy no_write_policy_update on no_write_policy for update
        using (team_id = current_setting('warden.team_id', true));

      create table no_team_in_policies (team_id text);
      alter table no_team_in_policies enable row level security;
      alter table no_team_in_policies force row level security;
      create policy any_select on no_team_in_policies for select using (true);
      create policy any_insert on no_team_in_policies for insert with check (true);
      create policy any_update on no_team_in_policies for update using (true);
      create policy any_delete on no_team_in_policies for delete using (true);

      create table team_read_any_write (team_id text);
      alter table team_read_any_write enable row level security;
      alter table team_read_any_write force row level security;
      create policy team_read_any_write_all on team_read_any_write for all
        using (team_id = current_setting('warden.team_id', true)) with check (true);

      create table admin_only_policy (team_id text);
      alter table admin_only_policy enable row level security;
      alter table admin_only_policy force row level security;
      create policy admin_only on admin_only_policy for all to warden_admin
        using (team_id = current_setting('warden.team_id', true));

      create table one_policy_each (team_id text);
      alter table one_policy_each enable row level security;
      alter table one_policy_each force row level security;
      create policy one_select on one_policy_each for select to warden_app
        using (team_id = current_setting('warden.team_id', true));
      create policy one_insert on one_policy_each for insert
        with check (team_id = current_setting('warden.team_id', true));
      create policy one_update on one_policy_each for update
        using (team_id = current_setting('warden.team_id', true));
      create policy one_delete on one_policy_each for delete
        using (team_id = current_setting('warden.team_id', true));
    `);

    expect(await findUnprotectedTables(pool)).toEqual([
      "admin_only_policy",
      "no_rls",
      "no_team_in_policies",
      "no_write_policy",
      "not_forced",
      "team_read_any_write",
    ]);
  });

  it("names a table whose Team policy has a permissive policy beside it that doesn't read the Team", async () => {
    const { pool } = await migratedDatabase();
    const teamTable = (name: string) => `
      create table ${name} (team_id text);
      alter table ${name} enable row level security;
      alter table ${name} force row level security;
      create policy ${name}_team on ${name} for all
        using (team_id = current_setting('warden.team_id', true))
        with check (team_id = current_setting('warden.team_id', true));
    `;
    await pool.query(`
      ${teamTable("app_reads_any")}
      create policy app_reads_any_all on app_reads_any for select to warden_app using (true);

      ${teamTable("everyone_any")}
      create policy everyone_any_all on everyone_any for all using (true);

      ${teamTable("restricted_further")}
      create policy restricted_further_more on restricted_further as restrictive for select to warden_app
        using (true);

      ${teamTable("admin_reads_any")}
      create policy admin_reads_any_all on admin_reads_any for select to warden_admin using (true);
    `);

    expect(await findUnprotectedTables(pool)).toEqual(["app_reads_any", "everyone_any"]);
  });

  // A policy for a role the app role is a member of applies to the app role. Shown on warden_preview_app, an app role
  // the check knows, as giving warden_app a membership would change it for every other test file running at once.
  it("counts a policy for a role an app role is a member of, directly or indirectly", async () => {
    const { pool } = await migratedDatabase();
    const superuser = createPool(silent, { max: 1 });
    cleanups.splice(0, 0, () => superuser.end());
    const base = testName();
    const [readers, middle] = [`${base}_readers`, `${base}_middle`];
    const { rows } = await superuser.query(
      "select from pg_roles where rolname = 'warden_preview_app'",
    );
    const made = rows.length === 0;
    if (made) await superuser.query("create role warden_preview_app login");
    await superuser.query(`create role ${readers} nologin; create role ${middle} nologin`);
    await superuser.query(`grant ${readers} to ${middle}; grant ${middle} to warden_preview_app`);
    // Run after the database is dropped (cleanups run in reverse), so no policy still names them, and before the
    // superuser's pool ends.
    cleanups.splice(1, 0, async () => {
      await superuser.query(`revoke ${middle} from warden_preview_app`);
      await superuser.query(`drop role if exists ${middle}; drop role if exists ${readers}`);
      if (made) await superuser.query("drop role if exists warden_preview_app");
    });
    const teamTable = (table: string) => `
      create table ${table} (team_id text);
      alter table ${table} enable row level security;
      alter table ${table} force row level security;
      create policy ${table}_team on ${table} for all
        using (team_id = current_setting('warden.team_id', true))
        with check (team_id = current_setting('warden.team_id', true));
    `;
    await pool.query(`
      ${teamTable("direct_group_reads_any")}
      create policy direct_group_reads_any_all on direct_group_reads_any for select to ${middle} using (true);

      ${teamTable("indirect_group_reads_any")}
      create policy indirect_group_reads_any_all on indirect_group_reads_any for select to ${readers}
        using (true);
    `);

    expect(await findUnprotectedTables(pool)).toEqual([
      "direct_group_reads_any",
      "indirect_group_reads_any",
    ]);
  });

  it("names a table in a schema other than public, schema-qualified", async () => {
    const { name, pool } = await migratedDatabase();
    const superuser = createPool(
      createLogger(() => {}),
      { database: name, max: 1 },
    );
    cleanups.push(() => superuser.end());
    await superuser.query(`
      create schema other;
      create table other.rows (team_id text);
      alter table other.rows enable row level security;
      alter table other.rows force row level security;
      create policy other_rows_team on other.rows for all
        using (team_id = current_setting('warden.team_id', true))
        with check (team_id = current_setting('warden.team_id', true));
    `);

    expect(await findUnprotectedTables(pool)).toEqual(["other.rows"]);
  });

  it("leaves warden_app usage on no schema but public, pg_catalog and information_schema", async () => {
    const { name } = await migratedDatabase();
    const superuser = createPool(
      createLogger(() => {}),
      { database: name, max: 1 },
    );
    cleanups.push(() => superuser.end());
    await superuser.query("create schema other; create table other.rows (team_id text)");
    const app = poolAs("warden_app", name);
    cleanups.push(() => app.end());

    const { rows } = await app.query<{ nspname: string }>(`
      select nspname from pg_namespace
       where has_schema_privilege(oid, 'usage')
         and nspname !~ '^pg_(toast_)?temp_'
       order by nspname
    `);

    expect(rows.map((row) => row.nspname)).toEqual(["information_schema", "pg_catalog", "public"]);
  });

  it("names a materialized view and a foreign table, which row-level security doesn't cover", async () => {
    const { name, pool } = await migratedDatabase();
    // A foreign data wrapper needs the superuser (the PG* user).
    const superuser = createPool(
      createLogger(() => {}),
      { database: name, max: 1 },
    );
    cleanups.push(() => superuser.end());
    await superuser.query(`
      create foreign data wrapper test_fdw;
      create server test_server foreign data wrapper test_fdw;
      create foreign table remote_rows (team_id text) server test_server;
    `);
    await pool.query("create materialized view team_totals as select id from teams");

    expect(await findUnprotectedTables(pool)).toEqual(["remote_rows", "team_totals"]);
  });
});
