import { defineConfig } from "vitest/config";

// Guard's permission-skip corpus (#433) on its own: the run its snapshot is refreshed with. It reads no database, so
// it has none of `vitest.config.ts`'s global setup, and runs from a fresh shell with no Postgres. The fast lane still
// runs it with the rest of the server's tests.
export default defineConfig({
  test: {
    include: ["src/modules/guard/permission-skip-corpus.test.ts"],
  },
});
