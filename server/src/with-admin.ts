// THE ONLY CROSS-TEAM ACCESS. Everything else goes through `withTeam`, where row-level security keeps each Team's
// rows apart (ADR 0006). `withAdmin` connects as warden_admin, which bypasses those policies, for the few deliberate
// tasks that need every Team at once (the dev page's totals). It can only read: `0001_app_grants` gives warden_admin
// select and nothing else. Keep its callers few and named; never reach it from code that serves one Team's request.
import { Kysely, PostgresDialect, type PostgresPool, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

export type WithAdmin = <T>(work: (tx: Transaction<Database>) => Promise<T>) => Promise<T>;

/** `pool` is a `pg.Pool` connected as warden_admin; the caller ends it. */
export function createWithAdmin(pool: PostgresPool): WithAdmin {
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return (work) => db.transaction().execute(work);
}
