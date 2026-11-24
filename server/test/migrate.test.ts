// The migration runner: file-name order, nothing new on a second run, a failing file, the wrong user, no database.
// Each case gets a fresh database; the grants case uses the suite's migrated one. Cases that assert the exit code or
// the output run it as its own process; the rest call `migrate` directly.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/migrate.ts";
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

/** The migrations Warden ships, by name, in byte order of their file names. */
const shipped = readdirSync(MIGRATIONS_FOLDER)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => file.slice(0, -".sql".length));

describe("pnpm migrate", () => {
  it("applies the migrations folder, then nothing on a second run", async () => {
    const database = await freshDatabase();

    const first = await runInServer(["pnpm", "--silent", "migrate"], asMigrate(database.name));
    expect(first.code, first.output).toBe(0);
    expect(await appliedMigrations(database.pool)).toEqual(shipped);

    const second = await runInServer(["pnpm", "--silent", "migrate"], asMigrate(database.name));
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('"message":"applied"');
    expect(await appliedMigrations(database.pool)).toEqual(shipped);
  });

  it("refuses to run as any user but warden_migrate, applying nothing", async () => {
    const database = await freshDatabase();

    // The PG* superuser: tables it made would miss warden_migrate's default grants.
    const result = await runInServer(["pnpm", "--silent", "migrate"], {
      PGDATABASE: database.name,
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("warden_migrate");
    const { rows } = await database.pool.query(
      "select to_regclass('kysely_migration') is not null as tracked",
    );
    expect(rows[0]).toEqual({ tracked: false });
  });
});

describe("the migration runner", () => {
  const migrateProcess = (folder: string, env: Record<string, string>) =>
    runInServer([process.execPath, "src/migrate.ts", folder], env);

  it("applies files in the byte order of their names, not the order they were written", async () => {
    const database = await freshDatabase();
    // "0002_Beta" sorts before "0002_alpha" by bytes, after it in most locales.
    const folder = migrationsFolder({
      "0010_third.sql": "insert into ran (name) values ('0010_third');",
      "0002_alpha.sql": "insert into ran (name) values ('0002_alpha');",
      "0002_Beta.sql": "insert into ran (name) values ('0002_Beta');",
      "0001_first.sql":
        "create table ran (id int generated always as identity, name text); insert into ran (name) values ('0001_first');",
    });
    const order = ["0001_first", "0002_Beta", "0002_alpha", "0010_third"];

    const result = await migrate(database.pool, folder);

    expect(result).toEqual({ applied: order });
    const { rows } = await database.pool.query("select name from ran order by id");
    expect(rows.map((row) => row.name)).toEqual(order);
    expect(await appliedMigrations(database.pool)).toEqual(order);
  });

  it("reads back applied migrations with equal times in the same byte order", async () => {
    const database = await freshDatabase();
    const first = { "0001_Beta.sql": "select 1;", "0001_alpha.sql": "select 1;" };
    expect(await migrate(database.pool, migrationsFolder(first))).toEqual({
      applied: ["0001_Beta", "0001_alpha"],
    });
    // Two migrations recorded in the same millisecond: Kysely orders them by name, and must agree with the files.
    await database.pool.query("update kysely_migration set timestamp = '2026-11-24T00:00:00.000Z'");

    const result = await migrate(
      database.pool,
      migrationsFolder({ ...first, "0002_next.sql": "select 1;" }),
    );

    expect(result).toEqual({ applied: ["0002_next"] });
  });

  it("rolls back a failing file, names it, exits non-zero and applies no later file", async () => {
    const database = await freshDatabase();
    const folder = migrationsFolder({
      "0001_good.sql": "create table good (id int);",
      "0002_bad.sql": "create table half_made (id int); select * from no_such_table;",
      "0003_later.sql": "create table later (id int);",
    });

    const result = await migrateProcess(folder, asMigrate(database.name));

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
    const result = await migrateProcess(migrationsFolder({ "0001_any.sql": "select 1;" }), {
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ECONNREFUSED");
  });
});

describe("the first migration's grants", () => {
  const database = inject("testDatabase");

  async function laterTable() {
    const owner = poolAs("warden_migrate", database);
    const app = poolAs("warden_app", database);
    const admin = poolAs("warden_admin", database);
    cleanups.push(
      () => owner.end(),
      () => app.end(),
      () => admin.end(),
    );
    const table = `grants_check_${process.pid}`;
    // A serial key: inserting needs its sequence too.
    await owner.query(`create table ${table} (id bigserial primary key, note text)`);
    cleanups.push(() => owner.query(`drop table ${table}`));
    return { table, app, admin };
  }

  it("lets warden_app read and write a table warden_migrate makes later, but not Kysely's tables", async () => {
    const { table, app } = await laterTable();

    await app.query(`insert into ${table} (note) values ('written')`);
    await app.query(`update ${table} set note = 'changed'`);
    const { rows } = await app.query(`select note from ${table}`);
    expect(rows).toEqual([{ note: "changed" }]);
    await app.query(`delete from ${table}`);

    await expect(app.query("select * from kysely_migration")).rejects.toThrow(/permission denied/);
    await expect(app.query("select * from kysely_migration_lock")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("lets warden_admin read a table warden_migrate makes later, but not write it", async () => {
    const { table, app, admin } = await laterTable();
    await app.query(`insert into ${table} (note) values ('from the app')`);

    const { rows } = await admin.query(`select note from ${table}`);

    expect(rows).toEqual([{ note: "from the app" }]);
    await expect(admin.query(`insert into ${table} (note) values ('x')`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
