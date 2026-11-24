// The browser tests (`pnpm e2e`): the real server process on a throwaway Postgres database, serving a dashboard built
// in Vite's `e2e` mode, where a stand-in replaces Clerk. No Clerk account, key or network is needed. `pnpm e2e` (locally
// and in the fast lane) runs the `chromium` project only; the full lane (`full-lane.yml`) runs each project in its own
// job with `--project`.
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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
