// The migration runner: plain SQL files in server/migrations, applied in file-name order by Kysely's Migrator, as
// whatever PG* user the caller sets (warden_migrate). Forwards only: no down migrations.
//
// `pnpm migrate [folder]` exits non-zero, naming the file, when one fails, and with the driver's error when the
// database can't be reached.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import type pg from "pg";
import { createPool } from "./database.ts";
import { createLogger, type Logger } from "./log.ts";

/** Where the migrations live, here and in the image. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Each `.sql` file in `folder` as one migration, named by its file name without `.sql`. */
export function sqlFileMigrations(folder: string): MigrationProvider {
  return {
    async getMigrations() {
      const files = (await readdir(folder)).filter((file) => file.endsWith(".sql"));
      const migrations: Record<string, Migration> = {};
      for (const file of files) {
        const text = await readFile(join(folder, file), "utf8");
        migrations[file.slice(0, -".sql".length)] = {
          up: async (db) => {
            await sql.raw(text).execute(db);
          },
        };
      }
      return migrations;
    },
  };
}

export type MigrateResult = {
  /** The migrations this run applied, in order. */
  applied: string[];
  /** The migration that failed, when one did. */
  failed?: string;
  /** Why the run stopped: the failed migration's error, or the driver's when nothing could run. */
  error?: unknown;
};

/**
 * Applies every migration in `folder` not yet applied, each in its own transaction with its row in Kysely's table.
 * Never throws; the caller ends `pool`.
 *
 * One `migrateUp` per file, not `migrateToLatest`: on Postgres, Kysely runs every pending migration in one
 * transaction, so a failing file would also undo the good files before it.
 */
export async function migrate(pool: pg.Pool, folder = MIGRATIONS_FOLDER): Promise<MigrateResult> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({ db, provider: sqlFileMigrations(folder) });
  const applied: string[] = [];
  for (;;) {
    const { error, results = [] } = await migrator.migrateUp();
    if (error !== undefined) {
      return { applied, failed: results.find((r) => r.status === "Error")?.migrationName, error };
    }
    const step = results.filter((r) => r.status === "Success").map((r) => r.migrationName);
    if (step.length === 0) return { applied };
    applied.push(...step);
  }
}

async function main(logger: Logger, folder: string): Promise<number> {
  const pool = createPool(logger, { max: 1 });
  try {
    const { applied, failed, error } = await migrate(pool, folder);
    for (const migration of applied) logger.info("applied", { migration });
    if (error !== undefined) {
      const message = failed
        ? `migration ${failed} failed; it was rolled back and no later migration was applied`
        : "migrating failed before any migration ran";
      logger.error(message, { migration: failed, error });
      return 1;
    }
    logger.info(applied.length ? "migrations applied" : "nothing to migrate", {
      count: applied.length,
    });
    return 0;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(createLogger(), process.argv[2] ?? MIGRATIONS_FOLDER);
}
