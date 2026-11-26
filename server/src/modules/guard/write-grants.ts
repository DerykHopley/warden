// A Team's write grants (#224, stories 5 and 15): the installations of Warden's write GitHub app, which Fix PRs go
// through, that an Admin granted. Kept as an append-only record of `granted` and `revoked` events; the newest row per
// installation says whether the grant holds. Every call runs inside `withTeam`, so row-level security keeps each Team to
// its own rows (ADR 0006); an installation belongs to one Team only, across every Team.
import type { Selectable } from "kysely";
import { isPgError } from "../../database.ts";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";
import { InstallationLinkedElsewhere } from "./repo-assets.ts";

/** The key 0015_github_write_grants puts from each grant row to the one Team that holds its installation. */
const ONE_TEAM = "github_write_grants_one_team";

/** A write grant that holds: the installation, who granted it (a Clerk user id) and when. */
export type WriteGrant = { installationId: number; grantedBy: string; grantedAt: Date };

export interface WriteGrants {
  /**
   * Records a `granted` row for the installation and answers the grant. When the Team's newest row for it is already
   * `granted`, writes nothing and answers that grant. Throws InstallationLinkedElsewhere, writing nothing, for an
   * installation another Team's rows name, whatever its newest row says.
   */
  grant(team: string, input: { installationId: number; grantedBy: string }): Promise<WriteGrant>;
  /** The Team's installations whose newest row is `granted`, by installation id. */
  list(team: string): Promise<WriteGrant[]>;
}

/** A `granted` row as the store answers it; pg reads the bigint id back as a string. */
const writeGrant = (row: Selectable<Database["github_write_grants"]>): WriteGrant => ({
  installationId: Number(row.installation_id),
  grantedBy: row.caused_by,
  grantedAt: row.at,
});

export function createWriteGrants({ withTeam }: { withTeam: WithTeam }): WriteGrants {
  return {
    grant(team, { installationId, grantedBy }) {
      return withTeam(team, async (tx) => {
        const newest = await tx
          .selectFrom("github_write_grants")
          .selectAll()
          .where("installation_id", "=", String(installationId))
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst();
        if (newest?.event === "granted") return writeGrant(newest);
        try {
          // Another Team's row, which row-level security hides, may hold the id: then nothing is inserted here, and
          // the grant row below fails on the key to it.
          await tx
            .insertInto("github_write_installations")
            .values({ installation_id: installationId, team_id: team })
            .onConflict((conflict) => conflict.column("installation_id").doNothing())
            .execute();
          const row = await tx
            .insertInto("github_write_grants")
            .values({
              team_id: team,
              installation_id: installationId,
              event: "granted",
              caused_by: grantedBy,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return writeGrant(row);
        } catch (error) {
          // The transaction rolls back, so nothing is written.
          if (isPgError(error, "23503") && error.constraint === ONE_TEAM) {
            throw new InstallationLinkedElsewhere(installationId);
          }
          throw error;
        }
      });
    },

    list(team) {
      return withTeam(team, async (tx) => {
        const newest = await tx
          .selectFrom("github_write_grants")
          .selectAll()
          .distinctOn("installation_id")
          .orderBy("installation_id")
          .orderBy("id", "desc")
          .execute();
        return newest.filter((row) => row.event === "granted").map(writeGrant);
      });
    },
  };
}
