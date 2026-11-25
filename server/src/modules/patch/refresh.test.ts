// Patch's daily step, over fakes: which ids it scans, once each, and what one Scan throwing does. Which Findings'
// Assets it sweeps, and the sweep against the database, are in server/test/patch-refresh.test.ts.
import type { Product } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import type { Findings, ReconcileOutcome } from "../../findings/index.ts";
import { createLogger } from "../../log.ts";
import { createPatchRefresh } from "./refresh.ts";
import type { PatchScan } from "./scan.ts";

const TEAM = "org_refresh";

/** A deleted Product's id: a UUID, as `createProducts` gives every Product. */
const GONE = "5b0c2a4e-8f3d-4c1a-9e7b-2d6f0a1c3e5b";

const product = (id: string): Product => ({ id, name: id, repo_urls: [], dependencies: [] });

/** A Scan that records each Team and id it's called with, and throws for the ids in `failing`. */
function countingScan(failing: string[] = []) {
  const calls: { team: string; id: string }[] = [];
  const scan: PatchScan = {
    scanProduct: async (team, { id }) => {
      calls.push({ team, id });
      if (failing.includes(id)) throw new Error(`the Scan of ${id} failed`);
      return {} as ReconcileOutcome;
    },
  };
  return { scan, calls, ids: () => calls.map((call) => call.id) };
}

/**
 * The step over `products` and a Findings fake whose `assetRefs` answers `swept`, recording each Team and filter it's
 * asked for.
 */
function refresh(products: Product[], swept: string[], scan: PatchScan, lines: string[] = []) {
  const asked: { team: string; filter: Parameters<Findings["assetRefs"]>[1] }[] = [];
  const step = createPatchRefresh({
    products: { list: async () => products },
    findings: {
      assetRefs: async (team, filter) => {
        asked.push({ team, filter });
        return swept;
      },
    },
    scan,
    logger: createLogger((line) => lines.push(line)),
  });
  return { step, asked };
}

describe("Patch's daily step", () => {
  it("scans each Product, then each swept Product Asset with no Product, each id once", async () => {
    const { scan, calls, ids } = countingScan();
    const { step, asked } = refresh(
      [product("p-kept"), product("p-other")],
      [GONE, "p-kept"],
      scan,
    );

    const result = await step.run(TEAM);

    expect(ids()).toEqual(["p-kept", "p-other", GONE]);
    expect(calls.map((call) => call.team)).toEqual([TEAM, TEAM, TEAM]);
    expect(asked).toEqual([
      { team: TEAM, filter: { module: "patch", kind: "product", statuses: ["open", "accepted"] } },
    ]);
    expect(result).toEqual({ failed: false, counts: { productsScanned: 3, productsFailed: 0 } });
  });

  it("skips a swept ref that isn't a UUID, with no Scan and no log line, and still scans a Product whatever its id", async () => {
    const { scan, ids } = countingScan();
    const lines: string[] = [];
    // `shop` is the demo seed's made-up Product Asset: never a Product's id, so never a deleted Product.
    const { step } = refresh([product("p-kept")], ["shop", GONE, "p-kept"], scan, lines);

    const result = await step.run(TEAM);

    expect(ids()).toEqual(["p-kept", GONE]);
    expect(result).toEqual({ failed: false, counts: { productsScanned: 2, productsFailed: 0 } });
    expect(lines).toEqual([]);
  });

  it("logs a Scan that throws with the Team and Product id, scans the rest, and reports the Team as failed", async () => {
    const { scan, ids } = countingScan(["p-b"]);
    const lines: string[] = [];
    const { step } = refresh(
      [product("p-a"), product("p-b"), product("p-c")],
      [GONE],
      scan,
      lines,
    );

    const result = await step.run(TEAM);

    expect(ids()).toEqual(["p-a", "p-b", "p-c", GONE]);
    expect(result).toEqual({ failed: true, counts: { productsScanned: 3, productsFailed: 1 } });
    const errors = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.severity === "ERROR");
    expect(errors).toEqual([
      expect.objectContaining({
        team: TEAM,
        productId: "p-b",
        error: expect.objectContaining({ message: "the Scan of p-b failed" }),
      }),
    ]);
  });
});
