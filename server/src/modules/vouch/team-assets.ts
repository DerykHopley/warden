// The Team's Assets a Control's Rules are judged on (spec #341, slice 2b): its Repo Assets for a `guard/` Rule, its
// Products for a `patch/` Rule. Guard and Patch own those tables, and Vouch imports neither (ADR 0005), so the start-up
// file hands their stores in; each is named here only by the one read Vouch makes of it.
import type { JudgedKind } from "./verdict.ts";

export interface TeamAssets {
  /** The refs of the Team's Assets held now, by kind: each Repo Asset's ref, each Product's id. */
  held(team: string): Promise<Record<JudgedKind, string[]>>;
}

export function createTeamAssets({
  repoAssets,
  products,
}: {
  /** Guard's Repo Assets. */
  repoAssets: { list(team: string): Promise<readonly { ref: string }[]> };
  /** Patch's Products: a Product Asset's ref is its id. */
  products: { list(team: string): Promise<readonly { id: string }[]> };
}): TeamAssets {
  return {
    async held(team) {
      const repos = await repoAssets.list(team);
      const owned = await products.list(team);
      return { repo: repos.map(({ ref }) => ref), product: owned.map(({ id }) => id) };
    },
  };
}
