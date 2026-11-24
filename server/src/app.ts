// Warden's server: the API under /api and the built dashboard, from one origin.
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { atLeast, type HealthBody, type MeBody, type Role } from "@warden/contracts";
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
  /** Config's `behindCloudRun`: there the client's address is the last X-Forwarded-For entry; elsewhere the socket's. */
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
   * for failed sign-ins (before the token is checked), 401 for a missing or bad token. The attempt is counted before
   * the check, so tokens sent at once count too, and taken back unless the token was bad.
   */
  async function signIn(c: Context<AppEnv>): Promise<Session | Response> {
    const address = clientAddress(
      {
        forwardedFor: c.req.header("X-Forwarded-For"),
        socketAddress: c.env?.incoming?.socket.remoteAddress,
      },
      deps.behindCloudRun,
    );
    const retryAfter = signInLimit.attempt(address);
    if (retryAfter !== undefined) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many sign-in attempts" }, 429);
    }
    const token = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
    let session: Session | null;
    try {
      session = token === undefined ? null : await deps.verifySessionToken(token);
    } catch (error) {
      // Clerk couldn't be asked: the token wasn't found bad, so it doesn't count.
      signInLimit.takeBack(address);
      throw error;
    }
    if (session === null) return c.json({ error: "Not signed in" }, 401);
    signInLimit.takeBack(address);
    return session;
  }

  /**
   * Opening Warden, for GET /api/me and requireRole alike: the signed-in person, and with an active Organization their
   * Team and their Role in it after the first-use steps (creating or joining the Team). Or the answer that refuses
   * them: signIn's 429 or 401, or the 409 when their Team's Admin hasn't opened Warden yet (nothing was written). The
   * Role always comes from Warden's table, never from the token's Clerk role.
   */
  async function openSession(
    c: Context<AppEnv>,
  ): Promise<
    Response | { session: Session; team: null } | { session: Session; team: string; role: Role }
  > {
    const session = await signIn(c);
    if (session instanceof Response) return session;
    if (session.team === null) return { session, team: null };
    const opened = await deps.members.open({
      team: session.team.id,
      userId: session.userId,
      clerkRole: session.team.clerkRole,
    });
    if (opened.kind === "team_not_created") return c.json({ error: TEAM_NOT_CREATED }, 409);
    return { session, team: session.team.id, role: opened.role };
  }

  const requireRole: RequireRole = (needed) => async (c, next) => {
    const opened = await openSession(c);
    if (opened instanceof Response) return opened;
    if (opened.team === null) return c.json({ error: "Choose a Team first" }, 403);
    if (!atLeast(opened.role, needed)) return c.json({ error: "Your Role can't do this" }, 403);
    c.set("session", opened.session);
    c.set("team", opened.team);
    c.set("role", opened.role);
    await next();
  };

  app.get("/api/health", async (c) => {
    const body = await deps.checkHealth();
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  // Opening Warden creates or joins the Team, and answers the person's Team and Role (both null with no Team).
  app.get("/api/me", async (c) => {
    const opened = await openSession(c);
    if (opened instanceof Response) return opened;
    const { session, team } = opened;
    const role = team === null ? null : opened.role;
    return c.json({ userId: session.userId, team, role } satisfies MeBody);
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
