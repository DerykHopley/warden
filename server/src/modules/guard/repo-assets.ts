// A Team's Repo Assets (Guard spec, stories 1 and 15): the GitHub installations an Admin linked and the repos each
// lists, named by GitHub's `html_url`. A Guard Scan names only these. Every call runs inside `withTeam`, so row-level
// security keeps each Team to its own rows (ADR 0006); only an installation's id is unique across Teams (threat G6).
import { sql } from "kysely";
import type { Asset } from "@warden/contracts";
import { isPgError } from "../../database.ts";
import type { WithTeam } from "../../with-team.ts";

/** The constraint 0009_repo_assets puts on an installation's id across every Team. */
const ONE_TEAM = "github_installations_one_team";

/** A link of an installation another Team already linked: nothing was written, and that Team's rows are unchanged. */
export class InstallationLinkedElsewhere extends Error {
  override name = "InstallationLinkedElsewhere";
  constructor(installationId: number) {
    super(`GitHub installation ${installationId} is linked to another Team`);
  }
}

/** One of a Team's Repo Assets: its ref (GitHub's URL for it), GitHub's repo id, its installation and when listed. */
export type RepoAsset = { ref: string; githubId: number; installationId: number; listedAt: Date };

export interface RepoAssets {
  /**
   * Records the installation under the Team (a relink by the same Team updates who and when) and replaces that
   * installation's Repo Assets with `repos`, in one transaction. Throws InstallationLinkedElsewhere, writing nothing,
   * for an installation another Team linked.
   */
  link(
    team: string,
    input: { installationId: number; linkedBy: string; repos: { ref: string; githubId: number }[] },
  ): Promise<void>;
  /** The Team's Repo Assets, by ref. */
  list(team: string): Promise<RepoAsset[]>;
  /**
   * The Assets in `assets` that aren't the Team's Repo Assets, in the order given: matched on `ref` exactly, and any
   * Asset not of kind `repo` counts as outside.
   */
  outside(team: string, assets: readonly Asset[]): Promise<Asset[]>;
}

export function createRepoAssets({ withTeam }: { withTeam: WithTeam }): RepoAssets {
  return {
    link(team, { installationId, linkedBy, repos }) {
      return withTeam(team, async (tx) => {
        try {
          await tx
            .insertInto("github_installations")
            .values({ team_id: team, installation_id: installationId, linked_by: linkedBy })
            .onConflict((conflict) =>
              conflict
                .columns(["team_id", "installation_id"])
                .doUpdateSet({ linked_by: linkedBy, linked_at: sql<Date>`now()` }),
            )
            .execute();
        } catch (error) {
          // Another Team's row, which row-level security hides, holds the id: the transaction rolls back.
          if (isPgError(error, "23505") && error.constraint === ONE_TEAM) {
            throw new InstallationLinkedElsewhere(installationId);
          }
          throw error;
        }
        await tx
          .deleteFrom("repo_assets")
          .where("installation_id", "=", String(installationId))
          .execute();
        if (repos.length === 0) return;
        await tx
          .insertInto("repo_assets")
          .values(
            repos.map(({ ref, githubId }) => ({
              team_id: team,
              ref,
              github_id: githubId,
              installation_id: installationId,
            })),
          )
          // A repo another of the Team's installations listed moves to this one.
          .onConflict((conflict) =>
            conflict.columns(["team_id", "ref"]).doUpdateSet((eb) => ({
              github_id: eb.ref("excluded.github_id"),
              installation_id: eb.ref("excluded.installation_id"),
              listed_at: sql<Date>`now()`,
            })),
          )
          .execute();
      });
    },

    list(team) {
      return withTeam(team, async (tx) => {
        const rows = await tx
          .selectFrom("repo_assets")
          .selectAll()
          .orderBy(sql`ref collate "C"`)
          .execute();
        return rows.map((row) => ({
          ref: row.ref,
          githubId: Number(row.github_id),
          installationId: Number(row.installation_id),
          listedAt: row.listed_at,
        }));
      });
    },

    outside(team, assets) {
      return withTeam(team, async (tx) => {
        const refs = assets.filter((asset) => asset.kind === "repo").map((asset) => asset.ref);
        const held =
          refs.length === 0
            ? []
            : await tx.selectFrom("repo_assets").select("ref").where("ref", "in", refs).execute();
        const heldRefs = new Set(held.map((row) => row.ref));
        return assets.filter((asset) => asset.kind !== "repo" || !heldRefs.has(asset.ref));
      });
    },
  };
}
