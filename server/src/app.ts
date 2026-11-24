// Warden's server: the API under /api and the built dashboard, from one origin.
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { HealthBody, MeBody, Role } from "@warden/contracts";
import type { Session, VerifySessionToken } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { Members } from "./members.ts";
import { securityHeaders } from "./security-headers.ts";
import { clientAddress, createSignInLimit } from "./sign-in-limit.ts";

export type AppDeps = {
  logger: Logger;
  verifySessionToken: VerifySessionToken;
  /** Each person's Role in their Team, through withTeam on the server's pool. */
  members: Members;
  /** On Cloud Run (K_SERVICE set), the client's address is the last X-Forwarded-For entry; elsewhere the socket's. */
  behindCloudRun: boolean;
  checkHealth: () => Promise<HealthBody>;
  /** Clerk's Frontend API host, which the CSP allows. */
  frontendApiHost: string;
  /** The built dashboard's folder; without one (in development, where Vite serves it) only the API answers. */
  dashboardDir: string | undefined;
};

/** What a handler behind requireRole reads from the context: the session, its Team and the person's Role there. */
export type AppEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: { session: Session; team: string; role: Role };
};

/** Refuses a request unless the signed-in person's Role in their Team is at least `role`. */
export type RequireRole = (role: Role) => MiddlewareHandler<AppEnv>;

/** Adds routes behind the app's middleware, before the API's 404: tests mount throwaway routes here. */
export type MountRoutes = (app: Hono<AppEnv>, requireRole: RequireRole) => void;

/** Member < Lead < Admin: each Role includes the one below. */
const RANK: Record<Role, number> = { member: 0, lead: 1, admin: 2 };

const TEAM_NOT_CREATED = "Your Team's Admin must open Warden first";

export function createApp(deps: AppDeps, mount?: MountRoutes): Hono<AppEnv> {
  const { logger } = deps;
  const app = new Hono<AppEnv>();
  // Kept in this instance's memory: each Cloud Run instance counts on its own (threat A5).
  const signInLimit = createSignInLimit();

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

  /**
   * The session a request's bearer token gives, or the answer that refuses it: 429 while its address is held back
   * for failed sign-ins (before the token is checked), 401 for a missing or bad token, which counts as a failure.
   */
  async function signIn(c: Context<AppEnv>): Promise<Session | Response> {
    const address = clientAddress(
      {
        forwardedFor: c.req.header("X-Forwarded-For"),
        socketAddress: c.env?.incoming?.socket.remoteAddress,
      },
      deps.behindCloudRun,
    );
    const retryAfter = signInLimit.retryAfter(address);
    if (retryAfter !== undefined) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many sign-in attempts" }, 429);
    }
    const token = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
    const session = token === undefined ? null : await deps.verifySessionToken(token);
    if (session === null) {
      signInLimit.failed(address);
      return c.json({ error: "Not signed in" }, 401);
    }
    return session;
  }

  /** The person's Role in the session's Team, after the first-use steps; or the 409 that nothing was written. */
  async function roleIn(
    c: Context<AppEnv>,
    session: Session & { team: NonNullable<Session["team"]> },
  ): Promise<Role | Response> {
    const opened = await deps.members.open({
      team: session.team.id,
      userId: session.userId,
      clerkRole: session.team.clerkRole,
    });
    if (opened.kind === "team not created") return c.json({ error: TEAM_NOT_CREATED }, 409);
    return opened.role;
  }

  // The Role always comes from Warden's table (members), never from the token's Clerk role.
  const requireRole: RequireRole = (needed) => async (c, next) => {
    const session = await signIn(c);
    if (session instanceof Response) return session;
    if (session.team === null) return c.json({ error: "Choose a Team first" }, 403);
    const role = await roleIn(c, { ...session, team: session.team });
    if (role instanceof Response) return role;
    if (RANK[role] < RANK[needed]) return c.json({ error: "Your Role can't do this" }, 403);
    c.set("session", session);
    c.set("team", session.team.id);
    c.set("role", role);
    await next();
  };

  app.get("/api/health", async (c) => {
    const body = await deps.checkHealth();
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  // Opening Warden: creates the Team or joins it (the first-use steps), and answers the person's Team and Role.
  app.get("/api/me", async (c) => {
    const session = await signIn(c);
    if (session instanceof Response) return session;
    if (session.team === null) {
      return c.json({ userId: session.userId, team: null, role: null } satisfies MeBody);
    }
    const role = await roleIn(c, { ...session, team: session.team });
    if (role instanceof Response) return role;
    return c.json({ userId: session.userId, team: session.team.id, role } satisfies MeBody);
  });

  mount?.(app, requireRole);

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
