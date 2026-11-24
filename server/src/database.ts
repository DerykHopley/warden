// The Postgres pool and the health check. `pg` reads the standard PG* variables itself (on Cloud Run, PGHOST is
// the Cloud SQL socket directory).
import pg from "pg";
import type { HealthBody } from "@warden/contracts";
import type { Logger } from "./log.ts";

/** How long the health check waits for the database before calling it unreachable. */
const HEALTH_TIMEOUT_MS = 2000;

export function createPool(logger: Logger, overrides: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({
    max: 5,
    // A bound on opening a connection or waiting for a free one, so nothing waits forever. Queries have no pool-wide
    // limit; the health check sets its own 2 seconds.
    connectionTimeoutMillis: 10_000,
    ...overrides,
  });
  // An idle client's connection dropping is reported here; unhandled, it would end the process.
  pool.on("error", (error) => logger.warn("idle database client failed", { error }));
  return pool;
}

/** Warden's three database roles (ADR 0006): not a person's Role in a Team. `pnpm roles` makes them. */
export type DatabaseRoleNames = { migrate: string; app: string; admin: string };

export const DATABASE_ROLE_NAMES = {
  migrate: "warden_migrate",
  app: "warden_app",
  admin: "warden_admin",
} as const satisfies DatabaseRoleNames;

/** The owner previews' own three roles, for the `warden_preview` database: the same jobs as the live set, with their
 * own passwords, so preview code can't act as anything live. Roles belong to the whole Cloud SQL instance. */
export const PREVIEW_DATABASE_ROLE_NAMES = {
  migrate: "warden_preview_migrate",
  app: "warden_preview_app",
  admin: "warden_preview_admin",
} as const satisfies DatabaseRoleNames;

/** The role set WARDEN_DATABASE_ROLES picks: unset, empty or `live` the live set, `preview` the preview set. Any
 * other value throws, naming the variable and the two allowed values. */
export function databaseRoleNames(env: Record<string, string | undefined>): DatabaseRoleNames {
  const value = env.WARDEN_DATABASE_ROLES ?? "";
  if (value === "" || value === "live") return DATABASE_ROLE_NAMES;
  if (value === "preview") return PREVIEW_DATABASE_ROLE_NAMES;
  throw new Error(`WARDEN_DATABASE_ROLES must be live or preview, not ${JSON.stringify(value)}`);
}

/** Why a database role may not serve requests: it can get around row-level security. */
export type DatabaseRoleRefusal = { role: string; reason: string };

/** How long a new connection waits for its role check before it's closed. */
const ROLE_CHECK_TIMEOUT_MS = 5000;

/** What makes a role able to get around row-level security, as the check's query names it, with how it reads. A
 * table's owner isn't bound by its policies unless they're forced; the schema's or the database's owner, and the
 * migration role, can make or take over tables, so they own them as soon as there are any. The admin role is
 * refused by name too: on Cloud SQL it's made without BYPASSRLS, but it's still for cross-Team work only. */
const BYPASS_REASONS = {
  superuser: "is a superuser",
  bypassrls: "has BYPASSRLS",
  "table owner": "owns a table in public",
  "schema owner": "owns the schema public",
  "database owner": "owns the database",
  "migration role": "is the migration role",
  "admin role": "is the admin role",
} as const;

// The connected role and every role it can become through membership (any grant counts: one with only the admin
// option can grant itself the rest), with the first that can get around row-level security, and why. The role itself
// comes first. $1 is the migration roles' names, $2 the admin roles'.
const BYPASSING_ROLE_SQL = `
with recursive reachable (oid) as (
  select oid from pg_roles where rolname = current_user
  union
  select m.roleid from pg_auth_members m join reachable on m.member = reachable.oid
)
select * from (
  select current_user as role, r.rolname as via,
         case
           when r.rolsuper then 'superuser'
           when r.rolbypassrls then 'bypassrls'
           when exists (
             select from pg_class c
              where c.relowner = r.oid and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
           ) then 'table owner'
           when exists (select from pg_namespace n where n.nspname = 'public' and n.nspowner = r.oid)
             then 'schema owner'
           when exists (select from pg_database d where d.datname = current_database() and d.datdba = r.oid)
             then 'database owner'
           when r.rolname = any($1) then 'migration role'
           when r.rolname = any($2) then 'admin role'
         end as why
    from reachable join pg_roles r on r.oid = reachable.oid
) found
 where why is not null
 order by via = role desc, via
 limit 1`;

export type CheckDatabaseRoleOptions = {
  /** How long the check waits for its answer. */
  timeoutMs?: number;
  /** The migration and admin roles, refused by name; tests pass their own. Unset, both sets' are refused: the live
   * set's and the preview set's. */
  names?: Pick<DatabaseRoleNames, "migrate" | "admin">;
};

/** Whether the role `client` connected as can get around row-level security, and why; undefined when it can't. */
export async function checkDatabaseRole(
  client: Pick<pg.ClientBase, "query">,
  { timeoutMs = ROLE_CHECK_TIMEOUT_MS, names }: CheckDatabaseRoleOptions = {},
): Promise<DatabaseRoleRefusal | undefined> {
  const sets = names ? [names] : [DATABASE_ROLE_NAMES, PREVIEW_DATABASE_ROLE_NAMES];
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the database didn't answer the role check in time")),
      timeoutMs,
    );
  });
  try {
    // On a timeout the query is left running; the guard's throw closes its connection.
    const { rows } = await Promise.race([
      client.query<{ role: string; via: string; why: keyof typeof BYPASS_REASONS }>(
        BYPASSING_ROLE_SQL,
        [sets.map((set) => set.migrate), sets.map((set) => set.admin)],
      ),
      timeout,
    ]);
    const found = rows[0];
    if (!found) return undefined;
    const what = BYPASS_REASONS[found.why];
    const reason =
      found.via === found.role
        ? `${found.role} ${what}`
        : `${found.role} can become ${found.via}, which ${what}`;
    return { role: found.role, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** The role check itself failed (it didn't answer in time, or its query failed): nothing is known about the role. */
export class DatabaseRoleCheckError extends Error {
  override name = "DatabaseRoleCheckError";
}

/**
 * The pool's `onConnect`: every new connection checks its role before any query runs on it, and `refuse` is told
 * when the role can get around row-level security. A refusal, or a check that fails or takes longer than
 * `timeoutMs`, throws, so the pool closes the connection unused.
 */
export function guardDatabaseRole(
  refuse: (refusal: DatabaseRoleRefusal) => void,
  { timeoutMs = ROLE_CHECK_TIMEOUT_MS } = {},
) {
  return async (client: pg.ClientBase) => {
    let refusal: DatabaseRoleRefusal | undefined;
    try {
      refusal = await checkDatabaseRole(client, { timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseRoleCheckError(`database role check failed: ${message}`, { cause: error });
    }
    if (refusal) {
      refuse(refusal);
      throw new Error(`database role refused: ${refusal.reason}`);
    }
  };
}

/** Why the start-up connection failed: the database isn't there (yet), it refused the login, the role check
 * failed, or something else. */
export type ConnectionFailure = "unreachable" | "login refused" | "role check failed" | "other";

/** Node's codes for a host, port or socket that can't be reached. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // The Cloud SQL socket isn't there yet.
  "ENOENT",
]);

/** pg's own errors for a connection that timed out, or closed before it was ready. */
const UNREACHABLE_MESSAGES = new Set([
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
]);

/** Postgres's codes for a login it refuses: a wrong password, an unknown role, an unknown database. */
const LOGIN_REFUSED_CODES = new Set(["28P01", "28000", "3D000"]);

export function connectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof DatabaseRoleCheckError) return "role check failed";
  if (error instanceof pg.DatabaseError) {
    return LOGIN_REFUSED_CODES.has(error.code ?? "") ? "login refused" : "other";
  }
  if (!(error instanceof Error)) return "other";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return "unreachable";
  if (UNREACHABLE_MESSAGES.has(error.message)) return "unreachable";
  // Each address of a host that has several (localhost's ::1 and 127.0.0.1) failed.
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.every((inner) => connectionFailure(inner) === "unreachable")
      ? "unreachable"
      : "other";
  }
  return "other";
}

type Queryable = {
  query: (query: {
    text: string;
    query_timeout: number;
  }) => Promise<{ rows: { vector?: unknown }[] }>;
};

const unreachable: HealthBody = {
  status: "unavailable",
  database: "unreachable",
  vector: "unknown",
};

export function createHealthCheck(pool: Queryable, logger: Logger): () => Promise<HealthBody> {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("database did not answer in time")),
        HEALTH_TIMEOUT_MS,
      );
    });
    try {
      const { rows } = await Promise.race([
        pool.query({
          text: "select exists (select 1 from pg_available_extensions where name = 'vector') as vector",
          query_timeout: HEALTH_TIMEOUT_MS,
        }),
        timeout,
      ]);
      return rows[0]?.vector === true
        ? { status: "ok", database: "ok", vector: "available" }
        : { status: "unavailable", database: "ok", vector: "missing" };
    } catch (error) {
      logger.warn("health check: database unreachable", { error });
      return unreachable;
    } finally {
      clearTimeout(timer);
    }
  };
}
