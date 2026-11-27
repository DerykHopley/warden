// A Team's Catalogues (Vouch, spec #341, story 1): which Catalogues the Team's Admin turned on or off, who did and
// when, one row per Team and Catalogue in `team_catalogues` (0017), replaced on each change with no history. A
// Catalogue with no row is off. This store is the table's only writer, and every call runs inside `withTeam`, so
// row-level security keeps each Team to its own rows (ADR 0006).
import type { CatalogueId } from "@warden/contracts";
import { sql } from "kysely";
import type { WithTeam } from "../../with-team.ts";

/** A Catalogue the Team has set: on or off, who set it (an Admin's Clerk user id) and when. */
export type TeamCatalogueChoice = {
  catalogue: CatalogueId;
  on: boolean;
  setBy: string;
  setAt: Date;
};

/** Whether the Team whose `choices` these are has `catalogue` on: one it never set is off. */
export const isOn = (choices: readonly TeamCatalogueChoice[], catalogue: CatalogueId): boolean =>
  choices.find((choice) => choice.catalogue === catalogue)?.on ?? false;

export interface TeamCatalogues {
  /** Every Catalogue the Team has set, on or off. One it never set isn't listed: it is off. */
  list(team: string): Promise<TeamCatalogueChoice[]>;
  /** Stores the Team's choice for one Catalogue, replacing the last, with who set it and the time now. */
  set(team: string, change: { catalogue: CatalogueId; on: boolean; setBy: string }): Promise<void>;
}

export function createTeamCatalogues({ withTeam }: { withTeam: WithTeam }): TeamCatalogues {
  return {
    async list(team) {
      const rows = await withTeam(team, (tx) =>
        tx.selectFrom("team_catalogues").selectAll().orderBy("catalogue").execute(),
      );
      return rows.map((row) => ({
        catalogue: row.catalogue,
        on: row.turned_on,
        setBy: row.set_by,
        setAt: row.set_at,
      }));
    },

    async set(team, { catalogue, on, setBy }) {
      await withTeam(team, (tx) =>
        tx
          .insertInto("team_catalogues")
          .values({ team_id: team, catalogue, turned_on: on, set_by: setBy })
          .onConflict((conflict) =>
            conflict
              .columns(["team_id", "catalogue"])
              .doUpdateSet({ turned_on: on, set_by: setBy, set_at: sql<Date>`now()` }),
          )
          .execute(),
      );
    },
  };
}
