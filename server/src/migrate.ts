// The migration runner: plain SQL files in server/migrations, applied in file-name order by Kysely's Migrator, as
// warden_migrate (PGUSER=warden_migrate; any other user is refused). Forwards only: no down migrations.
//
// Row-level security on Team-owned tables is forced, so it binds warden_migrate too (ADR 0006): a data migration
// over Team-owned rows sees and writes none unless it sets `warden.team_id`, once per Team (see 0002_teams.sql).
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

/** The only user migrations run as: it owns the schema, and the default grants follow its tables. */
const MIGRATION_ROLE = "warden_migrate";

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
  // Only warden_migrate's tables get the default grants, so any other user would make tables the app can't use (or,
  // as a superuser, tables nobody else owns).
  try {
    const { rows } = await pool.query<{ user: string }>('select current_user as "user"');
    const user = rows[0]?.user;
    if (user !== MIGRATION_ROLE) {
      return {
        applied: [],
        error: new Error(
          `migrations run as ${MIGRATION_ROLE}, not ${user}: set PGUSER=${MIGRATION_ROLE}`,
        ),
      };
    }
  } catch (error) {
    return { applied: [], error };
  }

  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({
    db,
    provider: sqlFileMigrations(folder),
    // Kysely sorts the files by bytes but breaks ties between applied migrations with localeCompare; one order for
    // both, whatever the locale.
    nameComparator: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  });
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

/** What a failed run did: the file that failed, or how far it got before it stopped. */
export function failureMessage({ applied, failed }: MigrateResult): string {
  if (failed)
    return `migration ${failed} failed; it was rolled back and no later migration was applied`;
  if (applied.length === 0) return "migrating failed before any migration ran";
  return `migrating stopped after applying ${applied.join(", ")}; no later migration was applied`;
}

async function main(logger: Logger, folder: string): Promise<number> {
  const pool = createPool(logger, { max: 1 });
  try {
    const result = await migrate(pool, folder);
    const { applied, failed, error } = result;
    for (const migration of applied) logger.info("applied", { migration });
    if (error !== undefined) {
      logger.error(failureMessage(result), { migration: failed, error });
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
