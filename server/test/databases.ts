// Throwaway test databases, made through the PG* superuser: the roles, then owned by warden_migrate, then dropped.
// The developer's compose database is only where CREATE and DROP DATABASE are issued from; nothing is written to it.
// Used by the global setup (no vitest imports here) and by tests that need a fresh database of their own.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { createRoles } from "../src/roles.ts";

/** A database role (not a person's Role in a Team). */
export type DatabaseRole = "warden_migrate" | "warden_app" | "warden_admin";

const logger = createLogger(() => {});

/** A test database's name carries when it was made, so a later run can tell a killed run's leftovers from a live one. */
const PREFIX = "warden_test_";
const STALE_AFTER_SECONDS = 3600;

/** A new database with the roles in place and warden_migrate as its owner, and a way to drop it. `connection`
 * reaches the superuser; left empty, the PG* variables do. */
export async function createTestDatabase(connection: pg.PoolConfig = {}) {
  const name = `${PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString("hex")}`;
  const drop = () => dropDatabase(connection, name);
  await withPool(connection, (pool) => pool.query(`create database ${name}`));
  try {
    await withPool({ ...connection, database: name }, async (pool) => {
      await createRoles(pool);
      await pool.query(`alter database ${name} owner to warden_migrate`);
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, drop };
}

/** The names createTestDatabase makes: when, in seconds, then 12 hex digits. */
const TIMED_NAME = /^warden_test_(\d+)_[0-9a-f]{12}$/;
/** The names it made before names carried a time. */
const UNTIMED_NAME = /^warden_test_[0-9a-f]{12}$/;

/** Drops test databases made over an hour ago, or named before names carried a time: what a killed run left. A run
 * in progress (the suite takes seconds, CI stops at 10 minutes) keeps its own, and a database with the prefix that
 * createTestDatabase didn't name is someone's own and stays. */
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
