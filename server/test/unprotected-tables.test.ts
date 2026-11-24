// The CI check (ADR 0006): every table Warden ships keeps Teams apart, and a table that doesn't is named. Each case
// gets a fresh database: the grants test adds an unprotected table to the suite's shared one while it runs.
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { findUnprotectedTables } from "../src/unprotected-tables.ts";
import { createTestDatabase, poolAs } from "./databases.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh database with every shipped migration, and a pool on it as warden_migrate. */
async function migratedDatabase(): Promise<pg.Pool> {
  const database = await createTestDatabase();
  cleanups.push(database.drop);
  const pool = poolAs("warden_migrate", database.name);
  cleanups.push(() => pool.end());
  const result = await migrate(pool);
  if (result.error) throw new Error("migrating failed", { cause: result.error });
  return pool;
}

describe("findUnprotectedTables", () => {
  it("finds no unprotected table after every shipped migration", async () => {
    const pool = await migratedDatabase();

    expect(await findUnprotectedTables(pool)).toEqual([]);
  });

  it("names a table without row-level security, one not forced, and one missing a write policy", async () => {
    const pool = await migratedDatabase();
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

      create table one_policy_each (team_id text);
      alter table one_policy_each enable row level security;
      alter table one_policy_each force row level security;
      create policy one_select on one_policy_each for select using (true);
      create policy one_insert on one_policy_each for insert with check (true);
      create policy one_update on one_policy_each for update using (true);
      create policy one_delete on one_policy_each for delete using (true);
    `);

    expect(await findUnprotectedTables(pool)).toEqual(["no_rls", "no_write_policy", "not_forced"]);
  });
});
