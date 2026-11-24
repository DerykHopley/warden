// `withTeam(team, async (tx) => …)`: the way request and job code reaches the database (ADR 0006). It runs the
// callback in one transaction with the Team set in `warden.team_id` for that transaction only, so the row-level
// security policies show and accept that Team's rows and nothing carries into the connection's next use.
import { Kysely, PostgresDialect, sql, type PostgresPool, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

export type WithTeam<DB extends Database = Database> = <T>(
  team: string,
  work: (tx: Transaction<DB>) => Promise<T>,
) => Promise<T>;

/** `pool` is a `pg.Pool` connected as warden_app; the caller ends it. `DB` widens the tables only in tests. */
export function createWithTeam<DB extends Database = Database>(pool: PostgresPool): WithTeam<DB> {
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return async (team, work) => {
    // An empty Team would read as "no Team set": no rows, which looks like "nothing there" (ADR 0006). A padded one
    // matches no Team's row either, so it's a bug upstream, refused the same way.
    if (team.trim() === "") throw new Error("withTeam needs a Team: got an empty Team id");
    if (team.trim() !== team) throw new Error("withTeam got a Team id with spaces around it");
    return db.transaction().execute(async (tx) => {
      await sql`select set_config('warden.team_id', ${team}, true)`.execute(tx);
      return work(tx);
    });
  };
}
