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

type Queryable = {
  query: (query: { text: string; query_timeout: number }) => Promise<{ rows: { vector?: unknown }[] }>;
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
