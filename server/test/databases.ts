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

export type Role = "warden_migrate" | "warden_app" | "warden_admin";

const logger = createLogger(() => {});

/** A new database with the roles in place and warden_migrate as its owner, and a way to drop it. `connection`
 * reaches the superuser; left empty, the PG* variables do. */
export async function createTestDatabase(connection: pg.PoolConfig = {}) {
  const name = `warden_test_${randomBytes(6).toString("hex")}`;
  const drop = () =>
    withPool(connection, (pool) => pool.query(`drop database if exists ${name} with (force)`));
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

/** A pool on `database` as `role`, through createPool's overrides. The caller ends it. */
export function poolAs(role: Role, database: string): pg.Pool {
  return createPool(logger, { user: role, database, max: 2 });
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

/** Runs `command` in the server package as its own process, with `env` over the test's PG* variables. */
export function runInServer(
  [command, ...args]: [string, ...string[]],
  env: Record<string, string>,
) {
  const { PATH, HOME, PGHOST, PGPORT, PGUSER, PGDATABASE } = process.env;
  const child = spawn(command, args, {
    cwd: serverDir,
    env: { PATH, HOME, PGHOST, PGPORT, PGUSER, PGDATABASE, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return new Promise<{ code: number | null; output: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, output })),
  );
}
