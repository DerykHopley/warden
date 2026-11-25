// Patch's daily step against the database: a `product` Asset with an Open Patch Finding and no Product row (a delete
// whose Scan failed) has its Findings turned Fixed, and a Product that still exists keeps its Open ones. On the suite's
// shared database, which holds the CVE snapshot, with a Team of this file's own.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { createPatchRefresh } from "../src/modules/patch/refresh.ts";
import { createPatchScan } from "../src/modules/patch/scan.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { seedPatchFinding, seedProduct, seedTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({
    withTeam,
    moveRules: { guard: guardMoveRule, patch: patchMoveRule },
  });
});

afterAll(() => pool.end());

describe("Patch's daily step on the database", () => {
  it("turns Fixed every Open Finding on a Product the Team no longer has, and keeps a Product's that still exists", async () => {
    const team = `org_${randomUUID()}`;
    await seedTeam(withTeam, team, []);
    const kept = await seedProduct(withTeam, team, {
      name: "Chatbot",
      dependencies: [
        { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: false },
      ],
    });
    const stillOpen = await seedPatchFinding(withTeam, team, kept, { cve: "CVE-2023-36188" });
    // A Product deleted while its Scan failed: no row, two Open Findings.
    const gone = randomUUID();
    const orphans = await Promise.all(
      ["CVE-2023-36188", "CVE-2023-29374"].map((cve) =>
        seedPatchFinding(withTeam, team, gone, { cve }),
      ),
    );
    const logger = createLogger(() => {});
    const step = createPatchRefresh({
      products: createProducts({ withTeam }),
      findings,
      scan: createPatchScan({ findings, logger }),
      logger,
    });

    const result = await step.run(team);

    expect(result).toEqual({ failed: false, counts: { productsScanned: 2, productsFailed: 0 } });
    const after = await findings.list(team);
    const byId = new Map(after.map((f) => [f.id, f]));
    for (const orphan of orphans) expect(byId.get(orphan.id)?.status).toBe("fixed");
    expect(byId.get(stillOpen.id)?.status).toBe("open");
    expect(after.filter((f) => f.asset.ref === kept).map((f) => f.status)).not.toContain("fixed");
  }, 30_000);
});
