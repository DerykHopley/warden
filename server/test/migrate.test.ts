// The migration runner as its own process: file-name order, nothing new on a second run, a failing file, no
// database. Each case gets a fresh database; the grants case uses the suite's migrated one.
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { createTestDatabase, poolAs, runInServer } from "./databases.ts";
import { closedPort } from "./ports.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase() {
  const database = await createTestDatabase();
  cleanups.push(database.drop);
  const pool = poolAs("warden_migrate", database.name);
  cleanups.push(() => pool.end());
  return { name: database.name, pool };
}

/** A migrations folder holding `files`, written in the order given. */
function migrationsFolder(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "warden-migrations-"));
  cleanups.push(() => rm(folder, { recursive: true }));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(folder, name), sql);
  return folder;
}

const asMigrate = (database: string) => ({ PGUSER: "warden_migrate", PGDATABASE: database });

async function appliedMigrations(pool: { query: (text: string) => Promise<{ rows: unknown[] }> }) {
  const { rows } = await pool.query("select name from kysely_migration order by timestamp, name");
  return rows.map((row) => (row as { name: string }).name);
}

describe("pnpm migrate", () => {
  it("applies the migrations folder, then nothing on a second run", async () => {
    const database = await freshDatabase();

    const first = await runInServer(["pnpm", "--silent", "migrate"], asMigrate(database.name));
    expect(first.code, first.output).toBe(0);
    expect(await appliedMigrations(database.pool)).toEqual(["0001_app_grants"]);

    const second = await runInServer(["pnpm", "--silent", "migrate"], asMigrate(database.name));
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('"message":"applied"');
    expect(await appliedMigrations(database.pool)).toEqual(["0001_app_grants"]);
  });
});

describe("the migration runner", () => {
  const migrate = (folder: string, env: Record<string, string>) =>
    runInServer([process.execPath, "src/migrate.ts", folder], env);

  it("applies files in file-name order, not the order they were written", async () => {
    const database = await freshDatabase();
    const folder = migrationsFolder({
      "0010_third.sql": "insert into ran (name) values ('0010_third');",
      "0002_second.sql": "insert into ran (name) values ('0002_second');",
      "0001_first.sql":
        "create table ran (id int generated always as identity, name text); insert into ran (name) values ('0001_first');",
    });

    const result = await migrate(folder, asMigrate(database.name));

    expect(result.code, result.output).toBe(0);
    const { rows } = await database.pool.query("select name from ran order by id");
    expect(rows.map((row) => row.name)).toEqual(["0001_first", "0002_second", "0010_third"]);
    expect(await appliedMigrations(database.pool)).toEqual([
      "0001_first",
      "0002_second",
      "0010_third",
    ]);
  });

  it("rolls back a failing file, names it, exits non-zero and applies no later file", async () => {
    const database = await freshDatabase();
    const folder = migrationsFolder({
      "0001_good.sql": "create table good (id int);",
      "0002_bad.sql": "create table half_made (id int); select * from no_such_table;",
      "0003_later.sql": "create table later (id int);",
    });

    const result = await migrate(folder, asMigrate(database.name));

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("0002_bad");
    const { rows } = await database.pool.query(
      `select to_regclass('good') is not null as good, to_regclass('half_made') is not null as half_made,
              to_regclass('later') is not null as later`,
    );
    expect(rows[0]).toEqual({ good: true, half_made: false, later: false });
    expect(await appliedMigrations(database.pool)).toEqual(["0001_good"]);
  });

  it("exits non-zero with the driver's error when the database can't be reached", async () => {
    const result = await migrate(migrationsFolder({ "0001_any.sql": "select 1;" }), {
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ECONNREFUSED");
  });
});

describe("the first migration's grants", () => {
  const database = inject("testDatabase");

  it("lets warden_app read and write a table warden_migrate makes later, but not Kysely's tables", async () => {
    const owner = poolAs("warden_migrate", database);
    const app = poolAs("warden_app", database);
    cleanups.push(
      () => owner.end(),
      () => app.end(),
    );
    const table = `grants_check_${process.pid}`;
    await owner.query(`create table ${table} (id int primary key, note text)`);
    cleanups.push(() => owner.query(`drop table ${table}`));

    await app.query(`insert into ${table} (id, note) values (1, 'written')`);
    await app.query(`update ${table} set note = 'changed' where id = 1`);
    const { rows } = await app.query(`select note from ${table}`);
    expect(rows).toEqual([{ note: "changed" }]);
    await app.query(`delete from ${table} where id = 1`);

    await expect(app.query("select * from kysely_migration")).rejects.toThrow(/permission denied/);
    await expect(app.query("select * from kysely_migration_lock")).rejects.toThrow(
      /permission denied/,
    );
  });
});
