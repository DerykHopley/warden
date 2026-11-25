// Patch's daily step, over fakes: which ids it scans, once each, and what one Scan throwing does. The sweep of a
// deleted Product's Findings against the database is in server/test/patch-refresh.test.ts.
import { fingerprint, type Finding, type Product } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import type { ReconcileOutcome } from "../../findings/index.ts";
import { createLogger } from "../../log.ts";
import { createPatchRefresh } from "./refresh.ts";
import { PATCH_RULE, type PatchScan } from "./scan.ts";

const TEAM = "org_refresh";

const product = (id: string): Product => ({ id, name: id, repo_urls: [], dependencies: [] });

/** A Finding on `asset`, Open and Patch's unless `overrides` say otherwise. */
function finding(id: string, asset: Finding["asset"], overrides: Partial<Finding> = {}): Finding {
  const location = {
    kind: "dependency",
    package: "pkg:pypi/langchain",
    version: "0.0.200",
    vulnerability: `CVE-2023-${id}`,
  } as const;
  return {
    id,
    team: TEAM,
    asset,
    module: "patch",
    rule_id: PATCH_RULE,
    fingerprint: fingerprint(PATCH_RULE, location),
    location,
    severity: "high",
    title: "A known vulnerability",
    evidence: { summary: "Version 0.0.200 is affected." },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...overrides,
  };
}

const onProduct = (ref: string) => ({ kind: "product", ref }) as const;

/** A Scan that records each id it's called with, and throws for the ids in `failing`. */
function countingScan(failing: string[] = []) {
  const calls: string[] = [];
  const scan: PatchScan = {
    scanProduct: async (team, { id }) => {
      expect(team).toBe(TEAM);
      calls.push(id);
      if (failing.includes(id)) throw new Error(`the Scan of ${id} failed`);
      return {} as ReconcileOutcome;
    },
  };
  return { scan, calls };
}

function refresh(products: Product[], findings: Finding[], scan: PatchScan, lines: string[] = []) {
  return createPatchRefresh({
    products: { list: async () => products },
    findings: { list: async () => findings },
    scan,
    logger: createLogger((line) => lines.push(line)),
  });
}

describe("Patch's daily step", () => {
  it("scans each Product, then each Product Asset with an Open Patch Finding and no Product, each id once", async () => {
    const { scan, calls } = countingScan();
    const step = refresh(
      [product("p-kept"), product("p-other")],
      [
        finding("1", onProduct("p-kept")),
        finding("2", onProduct("p-kept")),
        finding("3", onProduct("p-gone")),
        finding("4", onProduct("p-gone")),
        // Not swept: Fixed, another module's, or not a Product.
        finding("5", onProduct("p-fixed"), { status: "fixed" }),
        finding("6", onProduct("p-accepted"), { status: "accepted" }),
        finding("7", onProduct("p-guard"), { module: "guard" }),
        finding("8", { kind: "repo", ref: "https://github.com/example/app" }),
      ],
      scan,
    );

    const result = await step.run(TEAM);

    expect(calls).toEqual(["p-kept", "p-other", "p-gone"]);
    expect(result).toEqual({ failed: false, counts: { productsScanned: 3, productsFailed: 0 } });
  });

  it("logs a Scan that throws with the Team and Product id, scans the rest, and reports the Team as failed", async () => {
    const { scan, calls } = countingScan(["p-b"]);
    const lines: string[] = [];
    const step = refresh(
      [product("p-a"), product("p-b"), product("p-c")],
      [finding("1", onProduct("p-gone"))],
      scan,
      lines,
    );

    const result = await step.run(TEAM);

    expect(calls).toEqual(["p-a", "p-b", "p-c", "p-gone"]);
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
