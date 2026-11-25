// One throwaway database for the server's tests: the roles, every migration as warden_migrate, then the tests; dropped
// at the end. Tests reach it with `inject("testDatabase")`. First, it clears out what killed runs left behind.
import type { TestProject } from "vitest/node";
import {
  createMigratedTestDatabase,
  dropStaleTestDatabases,
  dropStaleTestRoles,
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
  await dropStaleTestDatabases(connection);
  await dropStaleTestRoles(connection);
  const database = await createMigratedTestDatabase(connection);

  project.provide("testDatabase", database.name);
  return database.drop;
}
