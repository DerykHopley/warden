// What Vouch's routes and the app's Vouch reads (`createAuditReads`) share: its stores and Catalogues, built once here
// so the start-up file and the tests can't wire them apart. Vouch imports neither Guard nor Patch (ADR 0005), so the
// Findings reads and Guard's and Patch's stores are handed in.
import type { WithTeam } from "../../with-team.ts";
import { VDA_ISA_2027_1, type Catalogue } from "./catalogue.ts";
import { createControlReviews, type ControlReviews } from "./control-reviews.ts";
import type { VouchReads } from "./controls.ts";
import { createTeamAssets, type AssetStores, type TeamAssets } from "./team-assets.ts";
import { createTeamCatalogues, type TeamCatalogues } from "./team-catalogues.ts";

/** Vouch's stores and Catalogues. */
export type VouchDeps = {
  teamCatalogues: TeamCatalogues;
  /** Every Catalogue Warden has, in the order the API lists them. */
  catalogues: readonly Catalogue[];
  findings: VouchReads;
  teamAssets: TeamAssets;
  controlReviews: ControlReviews;
};

/**
 * Vouch's deps on `withTeam`, with VDA ISA 2027.1, which is read from its files (`loadCatalogue`) once, when this file
 * is first imported: a file that can't be read or fails its schema stops start-up with that error.
 */
export function createVouchDeps({
  withTeam,
  findings,
  repoAssets,
  products,
}: { withTeam: WithTeam; findings: VouchReads } & AssetStores): VouchDeps {
  return {
    teamCatalogues: createTeamCatalogues({ withTeam }),
    catalogues: [VDA_ISA_2027_1],
    findings,
    teamAssets: createTeamAssets({ repoAssets, products }),
    controlReviews: createControlReviews({ withTeam }),
  };
}
