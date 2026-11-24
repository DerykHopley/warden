import { defineConfig } from "vitest/config";

// The schemas are exercised by the server's and the dashboard's tests; contracts holds tests of its own only when
// it gains logic (reconcile cases, JSON Schema publishing).
export default defineConfig({
  test: { passWithNoTests: true },
});
