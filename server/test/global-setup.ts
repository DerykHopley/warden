// One throwaway database for the server's tests: the roles, every migration as warden_migrate, Patch's CVE snapshot
// loaded as the release loads it, then the tests; dropped at the end. Tests reach it with `inject("testDatabase")`.
// First, it waits for Postgres to take connections, then clears out what killed runs left behind.
import type { TestProject } from "vitest/node";
import {
  createMigratedTestDatabase,
  dropStaleTestDatabases,
  dropStaleTestRoles,
  loadTestCveSnapshot,
  waitForPostgres,
} from "./databases.ts";

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
  await waitForPostgres(connection); // a container started just before the run (#99)
  await dropStaleTestDatabases(connection);
  await dropStaleTestRoles(connection);
  const database = await createMigratedTestDatabase(connection);
  try {
    await loadTestCveSnapshot(database.name, connection);
  } catch (error) {
    await database.drop();
    throw error;
  }

  project.provide("testDatabase", database.name);
  return database.drop;
}
