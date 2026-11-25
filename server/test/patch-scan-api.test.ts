// Stories 3, 4 and 8 at the API: saving a Product runs its Patch Scan, so a CVE that affects a dependency is an Open
// Finding on the Product; an upgrade past the fix, dropping the dependency, or deleting the Product turns it Fixed;
// and no Team sees or changes another's. Through the real app with Patch's routes mounted as the start-up file mounts
// them, on the suite's shared database (which holds the CVE snapshot) with Teams of this file's own.
import { randomUUID } from "node:crypto";
import { Finding, FindingsBody, Product, type ProductInput } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createLogger } from "../src/log.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import type { PatchScan } from "../src/modules/patch/scan.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  patchMount,
  patchScan,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

const LEAD = "user_lead";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({ publicPem, withTeam, mount: patchMount(withTeam) }));
});

afterAll(() => pool.end());

async function team() {
  const id = `org_${randomUUID()}`;
  await seedTeam(withTeam, id, [[LEAD, "lead"]]);
  return id;
}

async function call(
  on: Hono<AppEnv>,
  method: string,
  path: string,
  { teamId, body }: { teamId: string; body?: unknown },
) {
  const token = await sessionToken(key, LEAD, 60, activeOrganization(teamId));
  const res = await on.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

const langchain = (version: string | null): ProductInput["dependencies"][number] => ({
  framework: "langchain",
  version,
  usage: "library",
  internet_facing: false,
});

async function create(teamId: string, input: ProductInput, on = app) {
  const { status, body } = await call(on, "POST", "/api/products", { teamId, body: input });
  expect(status).toBe(201);
  return Product.parse(body).id;
}

async function findings(teamId: string): Promise<Finding[]> {
  const { status, body } = await call(app, "GET", "/api/findings", { teamId });
  expect(status).toBe(200);
  return FindingsBody.parse(body).findings;
}

/** The Team's Findings on Product `id` for `cve`. */
async function findingsFor(teamId: string, id: string, cve: string) {
  return (await findings(teamId)).filter(
    (f) =>
      f.asset.ref === id && f.location.kind === "dependency" && f.location.vulnerability === cve,
  );
}

const cveOf = (f: Finding) => (f.location.kind === "dependency" ? f.location.vulnerability : "");

describe("saving a Product (story 3)", () => {
  it("opens a critical Finding for a CVE that affects its LangChain version, and none for one that doesn't", async () => {
    const teamId = await team();
    const id = await create(teamId, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [langchain("0.0.200")],
    });

    const [finding, ...more] = await findingsFor(teamId, id, "CVE-2023-36188");
    expect(more).toEqual([]);
    expect(finding).toMatchObject({
      module: "patch",
      rule_id: "patch/known-vulnerability",
      asset: { kind: "product", ref: id },
      status: "open",
      severity: "critical",
      location: {
        kind: "dependency",
        package: "pkg:pypi/langchain",
        version: "0.0.200",
        vulnerability: "CVE-2023-36188",
      },
    });
    expect(await findingsFor(teamId, id, "CVE-2023-29374")).toEqual([]);
  });

  it("opens a Finding for each CVE with OSV data, as version unknown, for a dependency with no version", async () => {
    const teamId = await team();
    const id = await create(teamId, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [langchain(null)],
    });
    const withOsv = await withTeam(teamId, (tx) =>
      tx
        .selectFrom("cve_osv")
        .select("cve_id")
        .distinct()
        .where("product", "=", "langchain")
        .execute(),
    );

    const opened = (await findings(teamId)).filter((f) => f.asset.ref === id);
    expect(withOsv.length).toBeGreaterThan(0);
    for (const { cve_id } of withOsv) expect(opened.map(cveOf)).toContain(cve_id);
    for (const f of opened) {
      expect(f).toMatchObject({ status: "open", location: { version: "unknown" } });
    }
  });
});

describe("the Scan reads the Product as stored when it reconciles", () => {
  // Two close changes to one Product each run a Scan; the one that reconciles last must not undo the newer change.
  // So the Scan reads the Product's dependencies itself, whatever Product object it's handed.
  const chatbot = (version: string): ProductInput => ({
    name: "Chatbot",
    repo_urls: [],
    dependencies: [langchain(version)],
  });

  it("scans a Product changed since the object it's handed was read as it is now", async () => {
    const teamId = await team();
    const products = createProducts({ withTeam });
    const stale = await products.create(teamId, chatbot("0.0.200"));
    await products.update(teamId, stale.id, chatbot("0.0.247"));

    await patchScan(withTeam).scanProduct(teamId, stale);

    expect(await findingsFor(teamId, stale.id, "CVE-2023-36188")).toEqual([]);
  });

  it("scans a Product deleted since the object it's handed was read as having no dependencies", async () => {
    const teamId = await team();
    const products = createProducts({ withTeam });
    const scan = patchScan(withTeam);
    const stale = await products.create(teamId, chatbot("0.0.200"));
    await scan.scanProduct(teamId, stale);
    expect((await findings(teamId)).length).toBeGreaterThan(1);
    await products.remove(teamId, stale.id);

    await scan.scanProduct(teamId, stale);

    expect(new Set((await findings(teamId)).map((f) => f.status))).toEqual(new Set(["fixed"]));
  });

  it("skips and logs a dependency on a framework Patch no longer knows, and scans the rest", async () => {
    const teamId = await team();
    const lines: string[] = [];
    const { id } = await createProducts({ withTeam }).create(teamId, chatbot("0.0.200"));
    // Stored before the framework left PATCH_FRAMEWORKS: the routes would refuse it now.
    await withTeam(teamId, (tx) =>
      tx
        .insertInto("product_dependencies")
        .values({
          team_id: teamId,
          product_id: id,
          framework: "retired-framework",
          version: "1.0.0",
          usage: "library",
          internet_facing: false,
        })
        .execute(),
    );

    await patchScan(
      withTeam,
      createLogger((line) => lines.push(line)),
    ).scanProduct(teamId, { id });

    expect(await findingsFor(teamId, id, "CVE-2023-36188")).toHaveLength(1);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        team: teamId,
        productId: id,
        framework: "retired-framework",
      }),
    );
  });
});

describe("changing or deleting a Product (story 4)", () => {
  it("turns the Finding Fixed when LangChain is upgraded past the fix", async () => {
    const teamId = await team();
    const input = { name: "Chatbot", repo_urls: [], dependencies: [langchain("0.0.200")] };
    const id = await create(teamId, input);

    const put = await call(app, "PUT", `/api/products/${id}`, {
      teamId,
      body: { ...input, dependencies: [langchain("0.0.247")] },
    });

    expect(put.status).toBe(200);
    expect((await findingsFor(teamId, id, "CVE-2023-36188")).map((f) => f.status)).toEqual([
      "fixed",
    ]);
  });

  it("turns every LangChain Finding Fixed when the dependency is dropped", async () => {
    const teamId = await team();
    const id = await create(teamId, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [langchain("0.0.200")],
    });
    expect((await findings(teamId)).length).toBeGreaterThan(1);

    const put = await call(app, "PUT", `/api/products/${id}`, {
      teamId,
      body: { name: "Chatbot", repo_urls: [], dependencies: [] },
    });

    expect(put.status).toBe(200);
    const statuses = new Set((await findings(teamId)).map((f) => f.status));
    expect(statuses).toEqual(new Set(["fixed"]));
  });

  it("turns every Finding on it Fixed when the Product is deleted", async () => {
    const teamId = await team();
    const id = await create(teamId, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [langchain("0.0.200")],
    });

    const deleted = await call(app, "DELETE", `/api/products/${id}`, { teamId });

    expect(deleted.status).toBe(204);
    const all = await findings(teamId);
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((f) => f.status))).toEqual(new Set(["fixed"]));
  });
});

describe("Teams apart (story 8)", () => {
  it("refuses another Team's Lead a change or delete, leaving the Findings as they were", async () => {
    const teamA = await team();
    const teamB = await team();
    const id = await create(teamA, {
      name: "Chatbot",
      repo_urls: [],
      dependencies: [langchain("0.0.200")],
    });
    const before = await findings(teamA);

    const put = await call(app, "PUT", `/api/products/${id}`, {
      teamId: teamB,
      body: { name: "Chatbot", repo_urls: [], dependencies: [] },
    });
    const deleted = await call(app, "DELETE", `/api/products/${id}`, { teamId: teamB });

    expect([put.status, deleted.status]).toEqual([404, 404]);
    expect(await findings(teamA)).toEqual(before);
    expect(await findings(teamB)).toEqual([]);
  });
});

describe("a Scan that throws", () => {
  it("keeps the change, answers as usual, and logs the Team and Product id", async () => {
    const teamId = await team();
    const lines: string[] = [];
    const throwing: PatchScan = {
      scanProduct: () => Promise.reject(new Error("the CVE tables are gone")),
    };
    const { app: failing } = testApp({
      publicPem,
      withTeam,
      mount: patchMount(withTeam, {
        scan: throwing,
        logger: createLogger((line) => lines.push(line)),
      }),
    });
    const input = { name: "Chatbot", repo_urls: [], dependencies: [langchain("0.0.200")] };

    const id = await create(teamId, input, failing);
    const put = await call(failing, "PUT", `/api/products/${id}`, { teamId, body: input });
    const stored = await call(failing, "GET", "/api/products", { teamId });
    const deleted = await call(failing, "DELETE", `/api/products/${id}`, { teamId });

    expect([put.status, deleted.status]).toEqual([200, 204]);
    expect(JSON.stringify(stored.body)).toContain(id);
    const errors = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.severity === "ERROR");
    expect(errors).toHaveLength(3);
    for (const entry of errors) {
      expect(entry).toMatchObject({ team: teamId, productId: id });
      expect(JSON.stringify(entry)).toContain("the CVE tables are gone");
    }
    expect(await findings(teamId)).toEqual([]);
  });
});
