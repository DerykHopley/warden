import { defineConfig } from "vitest/config";

// The server's integration tests reach Postgres through the standard PG* variables. Unset, they point at the
// compose file's database (127.0.0.1:54329); CI sets its own service's.
export default defineConfig({
  test: {
    env: {
      PGHOST: process.env.PGHOST ?? "127.0.0.1",
      PGPORT: process.env.PGPORT ?? "54329",
      PGUSER: process.env.PGUSER ?? "warden",
      PGDATABASE: process.env.PGDATABASE ?? "warden",
    },
  },
});
