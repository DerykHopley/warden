// Warden's server: the API under /api and the built dashboard, from one origin.
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  AcceptBody,
  atLeast,
  MarkMovedBody,
  ReasonBody,
  RoleChangeBody,
  type Actor,
  type Finding,
  type HealthBody,
  type HistoryBody,
  type MeBody,
  type MembersBody,
  type TeamMember,
  type Role,
} from "@warden/contracts";
import type { z } from "zod";
import type { Session, VerifySessionToken } from "./auth.ts";
import { DecisionRefused, FindingNotFound, NotALead, type Findings } from "./findings/index.ts";
import type { Logger } from "./log.ts";
import type { Members, TeamMemberRow } from "./members.ts";
import { securityHeaders } from "./security-headers.ts";
import { clientAddress, createSignInLimit } from "./sign-in-limit.ts";

export type AppDeps = {
  logger: Logger;
  verifySessionToken: VerifySessionToken;
  /** Each person's Role in their Team, through withTeam on the server's pool. */
  members: Members;
  /** The Findings module, with each module's move rule, through withTeam on the server's pool. */
  findings: Findings;
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
const ROLE_TOO_LOW = "Your Role can't do this";

function memberBody(member: TeamMemberRow): TeamMember {
  return { userId: member.userId, role: member.role, joinedAt: member.joinedAt.toISOString() };
}

/** A body a schema refused, as one line: each issue's field and message. */
function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

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
    // An auth scheme's name is case-insensitive (RFC 9110, 11.1): `bearer` and `BEARER` are `Bearer`.
    const token = /^Bearer (\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
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
    if (!atLeast(opened.role, needed)) return c.json({ error: ROLE_TOO_LOW }, 403);
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

  // The Team is always the session's, never the request's: row-level security through withTeam shows only its rows.
  app.get("/api/team/members", requireRole("member"), async (c) => {
    const members = await deps.members.list(c.get("team"));
    return c.json({ members: members.map(memberBody) } satisfies MembersBody);
  });

  // An Admin gives a person a Role (story 2). Clerk's org:admin follows a change to or from Admin.
  app.put("/api/team/members/:userId/role", requireRole("admin"), async (c) => {
    // A body that isn't JSON parses as undefined, which the schema refuses like a bad role.
    const parsed = RoleChangeBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Send JSON with a role of "member", "lead" or "admin"' }, 400);
    }

    const team = c.get("team");
    const userId = c.req.param("userId");
    const result = await deps.members.changeRole({
      team,
      userId,
      role: parsed.data.role,
      actorId: c.get("session").userId,
    });
    switch (result.kind) {
      case "changed":
      case "unchanged":
        return c.json(memberBody(result.member));
      case "no_such_member":
        return c.json({ error: "No such member" }, 404);
      case "not_admin":
        return c.json({ error: ROLE_TOO_LOW }, 403);
      case "last_admin":
        return c.json({ error: "A Team needs at least one Admin" }, 409);
      case "clerk_refused":
        logger.error("Clerk refused a Role change; nothing changed", {
          team,
          userId,
          error: result.error,
        });
        return c.json({ error: "Clerk didn't take the change; nothing changed" }, 502);
    }
  });

  /**
   * What a Findings call's refusal answers: 404 for an id the Team doesn't have (another Team's included), 409 for a
   * Status the decision doesn't take, 403 for a person no longer a Lead under the Team's lock. Nothing was written in
   * any of them. Anything else, a zod error included (stored or derived data that broke Finding v1), is thrown on to
   * the logged 500, which shows no schema text: only the route's own body parse answers 400.
   */
  function findingRefusal(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof FindingNotFound) return c.json({ error: "No such Finding" }, 404);
    if (error instanceof DecisionRefused) return c.json({ error: error.message }, 409);
    if (error instanceof NotALead) return c.json({ error: ROLE_TOO_LOW }, 403);
    throw error;
  }

  /**
   * A Lead's named decision on one Finding (story 4): the body parsed with its contracts schema, the Team and the
   * Actor taken from the session, never the request. Answers the Finding as changed.
   */
  function decisionRoute<Body>(
    path: string,
    schema: z.ZodType<Body>,
    decide: (team: string, id: string, input: Body & { actor: Actor }) => Promise<Finding>,
  ) {
    app.post(`/api/findings/:id/${path}`, requireRole("lead"), async (c) => {
      // A body that isn't JSON parses as undefined, which every schema refuses.
      const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const actor: Actor = { kind: "person", id: c.get("session").userId };
      try {
        return c.json(await decide(c.get("team"), c.req.param("id"), { ...parsed.data, actor }));
      } catch (error) {
        return findingRefusal(c, error);
      }
    });
  }

  const { findings } = deps;
  decisionRoute("accept", AcceptBody, (team, id, input) => findings.accept(team, id, input));
  decisionRoute("false-positive", ReasonBody, (team, id, input) =>
    findings.markFalsePositive(team, id, input),
  );
  decisionRoute("confirm-fix", ReasonBody, (team, id, input) =>
    findings.confirmFix(team, id, input),
  );
  decisionRoute("mark-moved", MarkMovedBody, (team, id, input) =>
    findings.markMoved(team, id, input),
  );
  decisionRoute("reopen", ReasonBody, (team, id, input) => findings.reopen(team, id, input));

  // Any person in the Team reads a Finding's history, oldest first.
  app.get("/api/findings/:id/history", requireRole("member"), async (c) => {
    try {
      const history = await findings.history(c.get("team"), c.req.param("id"));
      return c.json({ history } satisfies HistoryBody);
    } catch (error) {
      return findingRefusal(c, error);
    }
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
