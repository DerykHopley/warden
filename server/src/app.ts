// Warden's server: the API under /api and the built dashboard, from one origin.
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { HealthBody, MeBody } from "@warden/contracts";
import type { VerifySessionToken } from "./auth.ts";
import type { Logger } from "./log.ts";
import { securityHeaders } from "./security-headers.ts";

export type AppDeps = {
  logger: Logger;
  verifySessionToken: VerifySessionToken;
  checkHealth: () => Promise<HealthBody>;
  /** Clerk's Frontend API host, which the CSP allows. */
  frontendApiHost: string;
  /** The built dashboard's folder; without one (in development, where Vite serves it) only the API answers. */
  dashboardDir: string | undefined;
};

export function createApp(deps: AppDeps): Hono {
  const { logger } = deps;
  const app = new Hono();

  app.use(securityHeaders(deps.frontendApiHost));

  // One line per request: method, path with the query string's values masked by the logger, status, duration.
  // Headers are never logged.
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const url = new URL(c.req.url);
    logger.info("request", {
      method: c.req.method,
      path: url.pathname + url.search,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  app.get("/api/health", async (c) => {
    const body = await deps.checkHealth();
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  app.get("/api/me", async (c) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
    const userId = token === undefined ? null : await deps.verifySessionToken(token);
    if (userId === null) return c.json({ error: "Not signed in" }, 401);
    return c.json({ userId } satisfies MeBody);
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (deps.dashboardDir !== undefined) {
    app.use(serveStatic({ root: deps.dashboardDir }));
    // Any other page is a dashboard route, which the dashboard's index.html handles. A missing asset or any path
    // with a file extension is a missing file: it stays a 404, not the page.
    const indexHtml = serveStatic({ root: deps.dashboardDir, path: "index.html" });
    app.get(async (c, next) => {
      if (c.req.path.startsWith("/assets/") || /\.[^/]+$/.test(c.req.path)) return next();
      return indexHtml(c, next);
    });
  }

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    logger.error("unhandled error", { method: c.req.method, path: c.req.path, error });
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
