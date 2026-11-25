// Bug slice 6 of spec #101: before `load-cves` has run, the CVE tables are empty, and a Patch Scan reconciling against
// them would turn every CVE Finding Fixed. With no `cve_snapshot` row, the Scan throws naming `cve_snapshot` and
// `load-cves`, records nothing and changes no Finding; a Lead's save or delete still stands, and its log names both.
// On a migrated database of this file's own, with the CVE tables never loaded (the suite's shared one holds them).
import { randomUUID } from "node:crypto";
import type { Finding, ProductInput } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createMigratedTestDatabase, poolAs } from "./databases.ts";
import {
  activeOrganization,
  patchMount,
  patchScan,
  seedPatchFinding,
  seedProduct,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

const LEAD = "user_lead";
const CVE = "CVE-2023-36188";
const NOT_LOADED = /cve_snapshot[\s\S]*load-cves|load-cves[\s\S]*cve_snapshot/;

let drop: () => Promise<unknown>;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(async () => {
  const database = await createMigratedTestDatabase();
  drop = database.drop;
  pool = poolAs("warden_app", database.name);
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
}, 30_000);

afterAll(async () => {
  await pool.end();
  await drop();
}, 30_000);

const langchain = (version: string): ProductInput["dependencies"][number] => ({
  framework: "langchain",
  version,
  usage: "library",
  internet_facing: false,
});

/** A Team with a Lead, and a Product on LangChain 0.0.200 with an Open Finding for CVE-2023-36188 on it. */
async function teamWithFinding() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [[LEAD, "lead"]]);
  const productId = await seedProduct(withTeam, team, {
    name: "Chatbot",
    dependencies: [langchain("0.0.200")],
  });
  const finding = await seedPatchFinding(withTeam, team, productId, { cve: CVE });
  return { team, productId, finding };
}

const scansOf = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("scans").select("id").execute());

/** The Team's Findings as stored, which must be the one seeded, still Open, with nothing written since. */
async function expectUntouched(team: string, finding: Finding) {
  expect(await findings.list(team)).toEqual([finding]);
  expect(await findings.history(team, finding.id)).toEqual([]);
  expect(await scansOf(team)).toEqual([]);
}

describe("the Patch Scan with the CVE snapshot not loaded", () => {
  it("throws naming cve_snapshot and load-cves, records no Scan, and leaves the Open Finding Open", async () => {
    const { team, productId, finding } = await teamWithFinding();
    // The dependency dropped, so a Scan against empty tables would see nothing and turn the Finding Fixed.
    await withTeam(team, (tx) => tx.deleteFrom("product_dependencies").execute());

    await expect(patchScan(withTeam).scanProduct(team, { id: productId })).rejects.toThrow(
      NOT_LOADED,
    );

    await expectUntouched(team, finding);
  }, 30_000);
});

describe("a Lead's save or delete with the CVE snapshot not loaded", () => {
  let key: CryptoKey;
  let app: Hono<AppEnv>;
  const lines: string[] = [];

  beforeAll(async () => {
    const { privateKey, publicPem } = await testKey();
    key = privateKey;
    ({ app } = testApp({
      publicPem,
      withTeam,
      mount: patchMount(withTeam, { logger: createLogger((line) => lines.push(line)) }),
    }));
  });

  async function call(method: string, path: string, team: string, body?: unknown) {
    const token = await sessionToken(key, LEAD, 60, activeOrganization(team));
    const res = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.status;
  }

  /** The ERROR lines logged since `from`, each for `team`. */
  const errorsSince = (from: number) =>
    lines
      .slice(from)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.severity === "ERROR");

  it("a save that drops the vulnerable dependency answers 200 and stores it, the Finding stays Open, and the ERROR names both", async () => {
    const { team, productId, finding } = await teamWithFinding();
    const from = lines.length;

    const status = await call("PUT", `/api/products/${productId}`, team, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [],
    });

    expect(status).toBe(200);
    const stored = await withTeam(team, (tx) =>
      tx.selectFrom("product_dependencies").select("framework").execute(),
    );
    expect(stored).toEqual([]);
    await expectUntouched(team, finding);
    const [error, ...more] = errorsSince(from);
    expect(more).toEqual([]);
    expect(error).toMatchObject({ team, productId });
    expect(JSON.stringify(error?.error)).toMatch(NOT_LOADED);
  }, 30_000);

  it("a delete answers 204 and deletes the Product, the Finding stays Open, and the ERROR names both", async () => {
    const { team, productId, finding } = await teamWithFinding();
    const from = lines.length;

    const status = await call("DELETE", `/api/products/${productId}`, team);

    expect(status).toBe(204);
    const products = await withTeam(team, (tx) => tx.selectFrom("products").select("id").execute());
    expect(products).toEqual([]);
    await expectUntouched(team, finding);
    const [error, ...more] = errorsSince(from);
    expect(more).toEqual([]);
    expect(error).toMatchObject({ team, productId });
    expect(JSON.stringify(error?.error)).toMatch(NOT_LOADED);
  }, 30_000);
});
