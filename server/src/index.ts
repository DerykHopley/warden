// Starts Warden's server: configuration checked first, then the pool, the app and the listener on PORT.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClerkVerifier } from "./auth.ts";
import { clerkOrganizations } from "./clerk-organizations.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { connectionFailure, createHealthCheck, createPool, guardDatabaseRole } from "./database.ts";
import { createFindings } from "./findings/index.ts";
import { createLogger } from "./log.ts";
import { createMembers } from "./members.ts";
import { createGitHub } from "./modules/guard/github.ts";
import { hookRoutes } from "./modules/guard/hook-routes.ts";
import { createHookSettings } from "./modules/guard/hook-settings.ts";
import { createRepoAssets, guardAssetCheck } from "./modules/guard/repo-assets.ts";
import { guardRoutes } from "./modules/guard/routes.ts";
import { scanJobStarterFor } from "./scan-job-starters.ts";
import { createScans } from "./scans.ts";
import { createShutdown } from "./shutdown.ts";
import { MOVE_RULES, scanners } from "./wiring.ts";
import { createWithTeam } from "./with-team.ts";

const logger = createLogger();

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error(`Warden can't start. ${error.message}`, { variables: error.variables });
  process.exit(1);
}

// The built dashboard: `dashboard/dist` unless WARDEN_DASHBOARD_DIR names another build (the browser tests' own).
const dashboardDir =
  process.env.WARDEN_DASHBOARD_DIR ||
  fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
// Every new connection checks the role first; one that can get around row-level security stops the server before
// anything is answered from it.
const pool = createPool(logger, {
  onConnect: guardDatabaseRole(({ role, reason }) => {
    logger.error(
      `Warden can't start: its database role can bypass row-level security. ${reason}.`,
      {
        role,
        reason,
      },
    );
    process.exit(1);
  }),
});
// Connect once now, so a wrong role stops the server at start. When the database can't be reached yet, the server
// stays up (the health check answers 503) and the first connection that succeeds runs the check. A login the
// database refuses won't put itself right, so it stops the server too.
pool.query("select 1").catch((error: unknown) => {
  switch (connectionFailure(error)) {
    case "unreachable":
      logger.warn("database unreachable at start; the role is checked on the first connection", {
        error,
      });
      return;
    case "login refused":
      logger.error("Warden can't start: the database refused the login", {
        user: process.env.PGUSER,
        error,
      });
      process.exit(1);
      return;
    case "role check failed":
      logger.error("database role check failed at start; it runs again on the next connection", {
        error,
      });
      return;
    case "other":
      logger.error("database connection failed at start", { error });
  }
});
// Clerk's Backend API, with the secret key: a Warden Admin is Clerk's org:admin too (ADR 0008).
const clerk = createClerkClient({ secretKey: config.clerk.secretKey });
const withTeam = createWithTeam(pool);
const repoAssets = createRepoAssets({ withTeam });
const hookSettings = createHookSettings({ withTeam });
const scans = createScans({ withTeam });
// The Cloud Run Job when WARDEN_SCAN_JOB names one; else a child process off Cloud Run, and none on it (503). A Lead's
// start and the first Scan after a link both start it.
const startScanJob = scanJobStarterFor(config, { logger });
const app = createApp({
  logger,
  verifySessionToken: createClerkVerifier(config.clerk),
  members: createMembers({
    withTeam,
    clerkOrganizations: clerkOrganizations(clerk.organizations),
    logger,
  }),
  // ADR 0005: the modules come in here, through the wiring the Scan Job and the demo seed share.
  findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
  scans,
  // The Job's own list, so a start names the Rules the Job will run; the server reads no repo, so no RepoReader.
  scanners: scanners({ withTeam, logger }),
  // A Guard Scan names only the Team's Repo Assets.
  assetChecks: { guard: guardAssetCheck(repoAssets) },
  // Linking a GitHub installation needs the GitHub app's settings; without them its route answers 503. A link starts
  // the first Scan of its repos.
  moduleRoutes: [
    guardRoutes(
      config.github
        ? { repoAssets, scans, startScanJob, github: createGitHub(config.github), logger }
        : { repoAssets, scans, startScanJob },
    ),
    hookRoutes({ hookSettings }),
  ],
  startScanJob,
  behindCloudRun: config.behindCloudRun,
  checkHealth: createHealthCheck(pool, logger),
  frontendApiHost: config.clerk.frontendApiHost,
  dashboardDir: existsSync(`${dashboardDir}/index.html`) ? dashboardDir : undefined,
});

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  logger.info("listening", { port });
});

const shutdown = createShutdown({
  close: (done) => server.close(() => done()),
  end: () => pool.end(),
  exit: (code) => process.exit(code),
  logger,
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
