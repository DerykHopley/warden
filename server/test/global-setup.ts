// One throwaway database for the server's tests: the roles, every migration as warden_migrate, then the tests; dropped
// at the end. Tests reach it with `inject("testDatabase")`.
import type { TestProject } from "vitest/node";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase } from "./databases.ts";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: string;
  }
}

export default async function setup(project: TestProject) {
  // The global setup runs outside the test workers, so the config's PG* defaults are read from the config itself.
  const env = project.config.env;
  const connection = {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user: env.PGUSER,
    database: env.PGDATABASE,
  };
  const database = await createTestDatabase(connection);

  const logger = createLogger(() => {});
  const pool = createPool(logger, {
    ...connection,
    user: "warden_migrate",
    database: database.name,
  });
  try {
    const result = await migrate(pool);
    if (result.error)
      throw new Error("migrating the test database failed", { cause: result.error });
  } catch (error) {
    await database.drop();
    throw error;
  } finally {
    await pool.end();
  }

  project.provide("testDatabase", database.name);
  return database.drop;
}
