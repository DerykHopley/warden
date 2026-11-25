// Starts Warden's server: configuration checked first, then the pool, the app and the listener on PORT.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { serve } from "@hono/node-server";
import { createApp, type AppDeps } from "./app.ts";
import { createClerkVerifier } from "./auth.ts";
import { clerkOrganizations } from "./clerk-organizations.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { connectionFailure, createHealthCheck, createPool, guardDatabaseRole } from "./database.ts";
import { createFindings } from "./findings/index.ts";
import { createLogger } from "./log.ts";
import { createMembers } from "./members.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import { createProducts } from "./modules/patch/products.ts";
import { patchRoutes } from "./modules/patch/routes.ts";
import { createPatchScan } from "./modules/patch/scan.ts";
import { createShutdown } from "./shutdown.ts";
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
// ADR 0005: the modules come in here, the one shared file that may import them.
const findings = createFindings({
  withTeam,
  moveRules: { guard: guardMoveRule, patch: patchMoveRule },
});
const appDeps: AppDeps = {
  logger,
  verifySessionToken: createClerkVerifier(config.clerk),
  members: createMembers({
    withTeam,
    clerkOrganizations: clerkOrganizations(clerk.organizations),
    logger,
  }),
  findings,
  behindCloudRun: config.behindCloudRun,
  checkHealth: createHealthCheck(pool, logger),
  frontendApiHost: config.clerk.frontendApiHost,
  dashboardDir: existsSync(`${dashboardDir}/index.html`) ? dashboardDir : undefined,
};
// Each module's routes, behind the app's middleware (ADR 0005). Saving a Product runs its Patch Scan into Findings.
const app = createApp(
  appDeps,
  patchRoutes({
    products: createProducts({ withTeam }),
    scan: createPatchScan({ findings, logger }),
    logger,
  }),
);

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
