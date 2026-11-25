// The browser tests (`pnpm e2e`): the real server process on a throwaway Postgres database, serving a dashboard built
// in Vite's `e2e` mode, where a stand-in replaces Clerk. No Clerk account, key or network is needed. `pnpm e2e` (locally
// and in the fast lane) runs the `chromium` project only; the full lane (`full-lane.yml`) runs each project in its own
// job with `--project`.
//
// One project per run: each run's global setup seeds one database, and some tests change its data and put it back
// (e2e/decisions.spec.ts decides on Bluebird's Findings). Two projects in one run would race on the same rows, so a
// run that doesn't name exactly one project is refused. To try another browser, run it on its own:
// `pnpm --filter @warden/e2e exec playwright test --project firefox`.
import { defineConfig, devices } from "@playwright/test";

/** The projects a `playwright test` command line names: `--project a b` and `--project=a` alike, as Playwright reads them. */
function projectsNamed(argv: readonly string[]): string[] {
  const named: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--project=")) named.push(arg.slice("--project=".length));
    if (arg !== "--project") continue;
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) named.push(argv[++i]!);
  }
  return named;
}

// Checked once, in the process the command started: a test worker loads this file too, with no command line of its own.
const isWorker = process.env.TEST_WORKER_INDEX !== undefined;
if (!isWorker && process.argv[2] === "test" && projectsNamed(process.argv).length !== 1) {
  throw new Error(
    "Run one browser project per invocation (--project chromium, firefox or webkit): the projects share one " +
      "seeded database, and some tests change its data. See the comment at the top of e2e/playwright.config.ts.",
  );
}

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
