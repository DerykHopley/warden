// The browser tests (`pnpm e2e`): the real server process on a throwaway Postgres database, serving a dashboard built
// in Vite's `e2e` mode, where a stand-in replaces Clerk. No Clerk account, key or network is needed. The fast lane runs
// them in Chromium only.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  forbidOnly: !!process.env.CI,
  // A red test gets a diagnosis, never a rerun (CLAUDE.md): no retries.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
