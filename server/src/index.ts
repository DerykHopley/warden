// Starts Warden's server: configuration checked first, then the pool, the app and the listener on PORT.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClerkVerifier } from "./auth.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createHealthCheck, createPool, guardRole } from "./database.ts";
import { createLogger } from "./log.ts";
import { createShutdown } from "./shutdown.ts";

const logger = createLogger();

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error(`Warden can't start. ${error.message}`, { variables: error.variables });
  process.exit(1);
}

const dashboardDir = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
// Every new connection checks the role first; one that can get around row-level security stops the server before
// anything is answered from it.
const pool = createPool(logger, {
  onConnect: guardRole(({ role, reason }) => {
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
// stays up (the health check answers 503) and the first connection that succeeds runs the check.
pool.query("select 1").catch((error: unknown) => {
  logger.warn("database unreachable at start; the role is checked on the first connection", {
    error,
  });
});
const app = createApp({
  logger,
  verifySessionToken: createClerkVerifier(config.clerk),
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
