// Throwaway test databases, made through the PG* superuser: the roles, then owned by warden_migrate, then dropped.
// The developer's compose database is only where CREATE and DROP DATABASE are issued from; nothing is written to it.
// Used by the global setup (no vitest imports here) and by tests that need a fresh database of their own.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool, DATABASE_ROLE_NAMES, type DatabaseRoleNames } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { migrate, MIGRATIONS_FOLDER } from "../src/migrate.ts";
import { createRoles } from "../src/roles.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";

/** A database role (not a person's Role in a Team). */
export type DatabaseRole = (typeof DATABASE_ROLE_NAMES)[keyof typeof DATABASE_ROLE_NAMES];

const logger = createLogger(() => {});

/** A test database's name carries when it was made, so a later run can tell a killed run's leftovers from a live one. */
const PREFIX = "warden_test_";
const STALE_AFTER_SECONDS = 3600;

/** A new database with the roles in place and the migration role as its owner, and a way to drop it. `connection`
 * reaches the superuser; left empty, the PG* variables do. `names` is the role set: the live one by default.
 * Creating or dropping a database waits on a Postgres checkpoint, which took over vitest's 5 s default in full runs:
 * each test or hook that creates or drops one passes a 30 s timeout (`30_000`), and the other tests keep the default. */
export async function createTestDatabase(
  connection: pg.PoolConfig = {},
  names: DatabaseRoleNames = DATABASE_ROLE_NAMES,
) {
  const name = testName();
  const drop = () => dropDatabase(connection, name);
  await withPool(connection, (pool) => pool.query(`create database ${name}`));
  try {
    await withPool({ ...connection, database: name }, async (pool) => {
      await createRoles(pool, { names, logger });
      await pool.query(`alter database ${name} owner to ${pg.escapeIdentifier(names.migrate)}`);
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, drop };
}

/** createTestDatabase, then every shipped migration as warden_migrate. A failed migration drops it and throws. */
export async function createMigratedTestDatabase(connection: pg.PoolConfig = {}) {
  const database = await createTestDatabase(connection);
  try {
    await migrateTestDatabase(database.name, MIGRATIONS_FOLDER, connection);
  } catch (error) {
    await database.drop();
    throw error;
  }
  return database;
}

/** Applies `folder`'s migrations not yet applied to the test database `name`, as warden_migrate; throws if one fails. */
async function migrateTestDatabase(name: string, folder: string, connection: pg.PoolConfig = {}) {
  const pool = createPool(logger, {
    ...connection,
    user: "warden_migrate",
    database: name,
    max: 1,
  });
  try {
    const result = await migrate(pool, folder);
    if (result.error)
      throw new Error("migrating the test database failed", { cause: result.error });
  } finally {
    await pool.end();
  }
}

/** A folder holding copies of the shipped migrations up to and including `last` (its name without `.sql`), and a way
 * to remove it. */
async function migrationsUpTo(last: string) {
  const folder = await mkdtemp(join(tmpdir(), "warden-migrations-"));
  const files = (await readdir(MIGRATIONS_FOLDER)).filter(
    (file) => file.endsWith(".sql") && file.slice(0, -".sql".length) <= last,
  );
  for (const file of files) await copyFile(join(MIGRATIONS_FOLDER, file), join(folder, file));
  return { folder, remove: () => rm(folder, { recursive: true }) };
}

/**
 * A migrated database of a test file's own, with a pool and a `withTeam` as each of `roles`: for a file that locks a
 * table other files write (a truncate, a drop), which on the suite's shared database can deadlock them. With
 * `upTo`, it is migrated only up to that shipped migration first, `before` writes data as that schema held it, and
 * then the later migrations run: what an upgrade does to stored data. `end` closes the pools and drops the database.
 * Making it waits on a checkpoint: the hook passes a 30 s timeout.
 */
export async function ownDatabase<R extends DatabaseRole>(
  roles: readonly R[],
  {
    upTo,
    before,
  }: { upTo?: string; before?: (withTeamAs: Record<R, WithTeam>) => Promise<void> } = {},
) {
  const database =
    upTo === undefined ? await createMigratedTestDatabase() : await createTestDatabase();
  const pools = {} as Record<R, pg.Pool>;
  const withTeamAs = {} as Record<R, WithTeam>;
  for (const role of roles) {
    pools[role] = poolAs(role, database.name);
    withTeamAs[role] = createWithTeam(pools[role]);
  }
  const end = async () => {
    for (const role of roles) await pools[role].end();
    await database.drop();
  };
  if (upTo !== undefined) {
    const older = await migrationsUpTo(upTo);
    try {
      await migrateTestDatabase(database.name, older.folder);
      await before?.(withTeamAs);
      await migrateTestDatabase(database.name, MIGRATIONS_FOLDER);
    } catch (error) {
      await end();
      throw error;
    } finally {
      await older.remove();
    }
  }
  return { pools, withTeamAs, end };
}

/** A name for a test database or test role: the prefix, when, in seconds, then 12 hex digits. A test role may add a
 * `_word` suffix. */
export function testName(): string {
  return `${PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString("hex")}`;
}

/** The names testName makes. */
const TIMED_NAME = /^warden_test_(\d+)_[0-9a-f]{12}$/;
/** The test roles' names: testName's, with an optional suffix. */
const TIMED_ROLE = /^warden_test_(\d+)_[0-9a-f]{12}(_[a-z]+)?$/;
/** The names it made before names carried a time. */
const UNTIMED_NAME = /^warden_test_[0-9a-f]{12}$/;

/** Drops test roles made over an hour ago: what a killed run left. Run it after dropStaleTestDatabases, as a stale
 * role's objects were in a stale database. A role with the prefix that testName didn't name is someone's own. */
export async function dropStaleTestRoles(connection: pg.PoolConfig = {}): Promise<void> {
  const { rows } = await withPool(connection, (pool) =>
    pool.query<{ rolname: string }>("select rolname from pg_roles where starts_with(rolname, $1)", [
      PREFIX,
    ]),
  );
  const now = Math.floor(Date.now() / 1000);
  for (const { rolname } of rows) {
    const made = TIMED_ROLE.exec(rolname)?.[1];
    if (made !== undefined && now - Number(made) > STALE_AFTER_SECONDS) {
      await withPool(connection, (pool) =>
        pool.query(`drop role if exists ${pg.escapeIdentifier(rolname)}`),
      );
    }
  }
}

/** Drops test databases made over an hour ago, or named before names carried a time: what a killed run left. A run
 * in progress (the suite takes seconds, CI stops at 10 minutes) keeps its own, and a database with the prefix that
 * testName didn't name is someone's own and stays. */
export async function dropStaleTestDatabases(connection: pg.PoolConfig = {}): Promise<void> {
  const { rows } = await withPool(connection, (pool) =>
    pool.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [PREFIX],
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  for (const { datname } of rows) {
    const made = TIMED_NAME.exec(datname)?.[1];
    const stale =
      made === undefined ? UNTIMED_NAME.test(datname) : now - Number(made) > STALE_AFTER_SECONDS;
    if (stale) {
      await dropDatabase(connection, datname);
    }
  }
}

/** A pool on `database` as `role`, through createPool's overrides. The caller ends it. */
export function poolAs(role: DatabaseRole, database: string): pg.Pool {
  return createPool(logger, { user: role, database, max: 2 });
}

function dropDatabase(connection: pg.PoolConfig, name: string) {
  return withPool(connection, (pool) =>
    pool.query(`drop database if exists "${name}" with (force)`),
  );
}

async function withPool<T>(connection: pg.PoolConfig, use: (pool: pg.Pool) => Promise<T>) {
  const pool = createPool(logger, { ...connection, max: 1 });
  try {
    return await use(pool);
  } finally {
    await pool.end();
  }
}

const serverDir = fileURLToPath(new URL("..", import.meta.url));

/** Runs `command` in the server package as its own process, with `env` over the test's environment (so PGPASSWORD
 * and PGSSL* reach it too). A command that can't start fails the test with the spawn error. */
export function runInServer(
  [command, ...args]: [string, ...string[]],
  env: Record<string, string>,
) {
  const child = spawn(command, args, { cwd: serverDir, env: { ...process.env, ...env } });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`couldn't run ${command}`, { cause: error })));
    child.on("close", (code) => resolve({ code, output }));
  });
}
