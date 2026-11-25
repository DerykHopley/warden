/**
 * Patch's daily step (spec #101, story 7): the daily Job runs it for each Team, so CVE Findings follow the snapshot
 * and each Product as stored, though nobody saves it. One Patch Scan per Product, then one per `product` Asset that
 * still has an Open or Accepted Patch Finding but no Product row: a delete whose Scan failed left them so, and that
 * Scan, of a Product the Team doesn't have, turns them Fixed (reconcile fixes an unseen Accepted Finding as it does an
 * Open one). Each Scan reads the Product under the Team's Findings lock, so a Product changed between the lists here
 * and its Scan is scanned as it is then.
 */
import type { Findings } from "../../findings/index.ts";
import type { Logger } from "../../log.ts";
import type { Products } from "./products.ts";
import type { PatchScan } from "./scan.ts";

/** One Team's counts: Scans that completed, and Scans that threw. */
export type PatchRefreshCounts = { productsScanned: number; productsFailed: number };

/** The step the daily Job runs for each Team (its `DailyStep`). */
export interface PatchRefresh {
  name: string;
  /** Scans every id; `failed` when any Scan threw, each logged with the Team and Product id. Never throws for one. */
  run(team: string): Promise<{ failed: boolean; counts: PatchRefreshCounts }>;
}

export function createPatchRefresh({
  products,
  findings,
  scan,
  logger,
}: {
  products: Pick<Products, "list">;
  findings: Pick<Findings, "assetRefs">;
  scan: PatchScan;
  logger: Logger;
}): PatchRefresh {
  return {
    name: "patch-refresh",
    async run(team) {
      const ids = new Set((await products.list(team)).map((product) => product.id));
      const swept = await findings.assetRefs(team, {
        module: "patch",
        kind: "product",
        statuses: ["open", "accepted"],
      });
      for (const ref of swept) ids.add(ref);
      const counts: PatchRefreshCounts = { productsScanned: 0, productsFailed: 0 };
      for (const id of ids) {
        try {
          await scan.scanProduct(team, { id });
          counts.productsScanned += 1;
        } catch (error) {
          counts.productsFailed += 1;
          logger.error("the daily Patch Scan of a Product failed; the Team's others still run", {
            team,
            productId: id,
            error,
          });
        }
      }
      return { failed: counts.productsFailed > 0, counts };
    },
  };
}
