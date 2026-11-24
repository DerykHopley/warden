// THE ONLY CROSS-TEAM ACCESS. Everything else goes through `withTeam`, where row-level security keeps each Team's
// rows apart (ADR 0006). `withAdmin` connects as warden_admin, which has no BYPASSRLS and one grant, select on
// `teams (id)`, with one policy (0006_proposals) that shows it every Team's id: so the daily Job (daily-expiry.ts,
// ADR 0009) can list the Teams and then change each one through `withTeam`. Every other table refuses it, a Team set
// in `warden.team_id` or not. It can only read, twice over: the transaction is read only, and that one grant is a
// select. Keep its callers few and named; never reach it from code that serves one Team's request.
import { Kysely, PostgresDialect, type PostgresPool, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

export type WithAdmin = <T>(work: (tx: Transaction<Database>) => Promise<T>) => Promise<T>;

/** `pool` is a `pg.Pool` connected as warden_admin; the caller ends it. */
export function createWithAdmin(pool: PostgresPool): WithAdmin {
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return (work) => db.transaction().setAccessMode("read only").execute(work);
}
