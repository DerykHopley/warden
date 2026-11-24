import { defineConfig } from "vitest/config";

// The server's integration tests reach Postgres through the standard PG* variables, as its superuser. Unset, they
// point at the compose file's database (127.0.0.1:54329); CI sets its own service's. The global setup makes a
// throwaway database from there (the roles, then every migration) and drops it after; the database PGDATABASE
// names is never migrated or written.
export default defineConfig({
  test: {
    env: {
      PGHOST: process.env.PGHOST ?? "127.0.0.1",
      PGPORT: process.env.PGPORT ?? "54329",
      PGUSER: process.env.PGUSER ?? "warden",
      PGDATABASE: process.env.PGDATABASE ?? "warden",
    },
    globalSetup: ["test/global-setup.ts"],
  },
});
