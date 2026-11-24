// Starts Warden's server: configuration checked first, then the pool, the app and the listener on PORT.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClerkVerifier } from "./auth.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createHealthCheck, createPool } from "./database.ts";
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
const pool = createPool(logger);
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
