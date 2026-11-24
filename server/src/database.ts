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

/** Why a database role may not serve requests: it can get around row-level security. */
export type RoleRefusal = { role: string; reason: string };

// The connected role and every role it can become through membership (any grant counts: one with only the admin
// option can grant itself the rest), with the first that is a superuser, has BYPASSRLS, or owns a table in public
// (a table's owner isn't bound by its policies unless they're forced). The role itself comes first.
const BYPASSING_ROLE_SQL = `
with recursive reachable (oid) as (
  select oid from pg_roles where rolname = current_user
  union
  select m.roleid from pg_auth_members m join reachable on m.member = reachable.oid
)
select current_user as role, r.rolname as via, r.rolsuper as superuser, r.rolbypassrls as bypassrls
  from reachable join pg_roles r on r.oid = reachable.oid
 where r.rolsuper or r.rolbypassrls
    or exists (
      select from pg_class c
       where c.relowner = r.oid and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    )
 order by r.rolname = current_user desc, r.rolname
 limit 1`;

/** Whether the role `client` connected as can get around row-level security, and why; undefined when it can't. */
export async function checkRole(
  client: Pick<pg.ClientBase, "query">,
): Promise<RoleRefusal | undefined> {
  const { rows } = await client.query<{
    role: string;
    via: string;
    superuser: boolean;
    bypassrls: boolean;
  }>(BYPASSING_ROLE_SQL);
  const found = rows[0];
  if (!found) return undefined;
  const what = found.superuser
    ? "a superuser"
    : found.bypassrls
      ? "BYPASSRLS"
      : "a table in public";
  const holds = found.superuser ? "is" : found.bypassrls ? "has" : "owns";
  const reason =
    found.via === found.role
      ? `${found.role} ${holds} ${what}`
      : `${found.role} can become ${found.via}, which ${holds} ${what}`;
  return { role: found.role, reason };
}

/**
 * The pool's `onConnect`: every new connection checks its role before any query runs on it, and `refuse` is told
 * when the role can get around row-level security. A check that fails throws, so the connection is closed unused.
 */
export function guardRole(refuse: (refusal: RoleRefusal) => void) {
  return async (client: pg.ClientBase) => {
    const refusal = await checkRole(client);
    if (refusal) {
      refuse(refusal);
      throw new Error(`database role refused: ${refusal.reason}`);
    }
  };
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
