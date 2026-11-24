// The CI check (ADR 0006): every table Warden ships keeps Teams apart, and a table that doesn't is named. Each case
// gets a fresh database: the grants test adds an unprotected table to the suite's shared one while it runs.
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { findUnprotectedTables } from "../src/unprotected-tables.ts";
import { createMigratedTestDatabase, poolAs } from "./databases.ts";

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
