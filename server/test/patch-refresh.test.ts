// Patch's daily step against the database: a `product` Asset with an Open or Accepted Patch Finding and no Product
// row (a delete whose Scan failed) has its Findings turned Fixed, and a Product that still exists keeps its Open ones;
// a Team stuck behind its Findings lock fails the step in time instead of hanging the Job. On the suite's shared
// database, which holds the CVE snapshot, with Teams of this file's own.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  patchRefresh,
  queuedBehindFindingsLock,
  seedPatchFinding,
  seedProduct,
  seedTeam,
} from "./helpers.ts";

let pool: pg.Pool;
let probe: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  // The probe holds a Team's lock on connections of its own, apart from the step's pool.
  probe = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
});

afterAll(async () => {
  await pool.end();
  await probe.end();
});

const LANGCHAIN = {
  framework: "langchain",
  version: "0.0.200",
  usage: "library",
  internet_facing: false,
} as const;

describe("Patch's daily step on the database", () => {
  it("turns Fixed every Open and Accepted Finding on a Product the Team no longer has, and keeps a Product's that still exists", async () => {
    const team = `org_${randomUUID()}`;
    await seedTeam(withTeam, team, []);
    const kept = await seedProduct(withTeam, team, { name: "Chatbot", dependencies: [LANGCHAIN] });
    const stillOpen = await seedPatchFinding(withTeam, team, kept, { cve: "CVE-2023-36188" });
    // Products deleted while their Scans failed: no rows. One has two Open Findings, the other only an Accepted one.
    const gone = randomUUID();
    const goneAccepted = randomUUID();
    const orphans = [
      await seedPatchFinding(withTeam, team, gone, { cve: "CVE-2023-36188" }),
      await seedPatchFinding(withTeam, team, gone, { cve: "CVE-2023-29374" }),
      await seedPatchFinding(withTeam, team, goneAccepted, {
        cve: "CVE-2023-34540",
        status: "accepted",
        accepted_reason: "Patched in our fork",
        accepted_until: "2027-06-01T00:00:00.000Z",
      }),
    ];

    const result = await patchRefresh(withTeam).run(team);

    expect(result).toEqual({ failed: false, counts: { productsScanned: 3, productsFailed: 0 } });
    const after = await findings.list(team);
    const byId = new Map(after.map((f) => [f.id, f]));
    for (const orphan of orphans) expect(byId.get(orphan.id)?.status, orphan.id).toBe("fixed");
    expect(byId.get(stillOpen.id)?.status).toBe("open");
    expect(after.filter((f) => f.asset.ref === kept).map((f) => f.status)).not.toContain("fixed");
  }, 30_000);

  it("gives up on a Product whose Team is stuck behind its Findings lock, logging it, instead of waiting", async () => {
    const team = `org_${randomUUID()}`;
    await seedTeam(withTeam, team, []);
    const productId = await seedProduct(withTeam, team, {
      name: "Chatbot",
      dependencies: [LANGCHAIN],
    });
    const lines: string[] = [];
    const holder = await probe.connect();
    try {
      // Another transaction holds the Team's Findings lock (a hung reconcile, say) throughout.
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [team]);

      // The Job's limits are 30 s and 60 s; the test's are short.
      const running = patchRefresh(
        withTeam,
        createLogger((line) => lines.push(line)),
        {
          lockTimeoutMs: 200,
        },
      ).run(team);
      await queuedBehindFindingsLock(probe, team);
      const result = await Promise.race([
        running,
        new Promise<"still waiting">((resolve) =>
          setTimeout(() => resolve("still waiting"), 5_000),
        ),
      ]);

      expect(result).toEqual({ failed: true, counts: { productsScanned: 0, productsFailed: 1 } });
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    const errors = lines.map((line) => JSON.parse(line)).filter((e) => e.severity === "ERROR");
    expect(errors).toEqual([
      expect.objectContaining({
        team,
        productId,
        error: expect.objectContaining({ code: "55P03" }),
      }),
    ]);
    expect(await findings.list(team)).toEqual([]);
  }, 30_000);
});
