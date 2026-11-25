// Stories 1, 2, 3 and 8 at the API, changing Products: a Lead or an Admin creates, changes and deletes the Team's
// Products, a Member is refused, a version its framework can't read is refused, each Team's saves are limited on their
// own, and no Team changes another's. Through the real app with Patch's routes mounted as the
// start-up file mounts them, as the person each session names, on the suite's shared database with Teams of this
// file's own.
import { randomUUID } from "node:crypto";
import { Product, ProductsBody, type ProductInput } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { createSaveLimit, type SaveLimit } from "../src/modules/patch/save-limit.ts";
import type { PatchScan } from "../src/modules/patch/scan.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { call, newTeam, patchMount, testApp, testKey } from "./helpers.ts";

const MEMBER = "user_member";
const LEAD = "user_lead";
const ADMIN = "user_admin";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  let privateKey: CryptoKey;
  ({ privateKey, publicPem } = await testKey());
  key = privateKey;
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({ publicPem, withTeam, mount: patchMount(withTeam) }));
});

/**
 * The app with a stand-in for the Patch Scan that records the Product id of each Scan it's asked for, and
 * `saveLimit` (by default, the start-up file's).
 */
function scanRecorded(saveLimit?: SaveLimit) {
  const scanned: string[] = [];
  const scan: PatchScan = {
    scanProduct: (_team, { id }) => {
      scanned.push(id);
      return Promise.resolve({
        opened: [],
        seen: [],
        fixed: [],
        reopened: [],
        alreadyApplied: false,
      });
    },
  };
  const { app: recorded } = testApp({
    publicPem,
    withTeam,
    mount: patchMount(withTeam, { scan, ...(saveLimit === undefined ? {} : { saveLimit }) }),
  });
  return { app: recorded, scanned };
}

afterAll(() => pool.end());

const team = () =>
  newTeam(withTeam, [
    [MEMBER, "member"],
    [LEAD, "lead"],
    [ADMIN, "admin"],
  ]);

const create = (teamId: string, body: unknown, as = LEAD, on = app) =>
  call(on, key, "POST", "/api/products", { as, teamId, body });
const replace = (teamId: string, id: string, body: unknown, as = LEAD, on = app) =>
  call(on, key, "PUT", `/api/products/${id}`, { as, teamId, body });
const remove = (teamId: string, id: string, as = LEAD, on = app) =>
  call(on, key, "DELETE", `/api/products/${id}`, { as, teamId });

async function list(teamId: string) {
  const { status, body } = await call(app, key, "GET", "/api/products", { as: MEMBER, teamId });
  expect(status).toBe(200);
  return ProductsBody.parse(body).products;
}

/** Everything stored for the Team's Products, read as that Team. */
function stored(teamId: string) {
  return withTeam(teamId, async (tx) => ({
    products: await tx.selectFrom("products").selectAll().orderBy("id").execute(),
    dependencies: await tx
      .selectFrom("product_dependencies")
      .selectAll()
      .orderBy(["product_id", "framework"])
      .execute(),
  }));
}

const supportBot: ProductInput = {
  name: "support bot",
  repo_urls: ["https://github.com/example/support-bot", "https://github.com/example/support-infra"],
  dependencies: [
    { framework: "langchain", version: "0.3.27", usage: "library", internet_facing: true },
  ],
};

/** A Product the Lead created through the API. */
async function created(teamId: string, input: ProductInput = supportBot) {
  const { status, body } = await create(teamId, input);
  expect(status).toBe(201);
  return Product.parse(body);
}

describe("a Lead or an Admin changing the Team's Products", () => {
  for (const as of [LEAD, ADMIN]) {
    it(`lets ${as === LEAD ? "a Lead" : "an Admin"} create, change and delete a Product`, async () => {
      const teamId = await team();

      const made = await create(teamId, supportBot, as);
      expect(made.status).toBe(201);
      const product = Product.parse(made.body);
      expect(product).toEqual({ id: expect.any(String), ...supportBot });
      expect(await list(teamId)).toEqual([product]);

      const changed: ProductInput = {
        ...supportBot,
        name: "Support assistant",
        dependencies: [
          { framework: "langchain", version: "0.3.28", usage: "transitive", internet_facing: true },
        ],
      };
      const put = await replace(teamId, product.id, changed, as);
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ id: product.id, ...changed });
      expect(await list(teamId)).toEqual([{ id: product.id, ...changed }]);

      const deleted = await remove(teamId, product.id, as);
      expect(deleted.status).toBe(204);
      expect(await list(teamId)).toEqual([]);
    });
  }

  it("replaces the whole Product on PUT: Repo URLs and dependencies left out are gone", async () => {
    const teamId = await team();
    const product = await created(teamId, {
      ...supportBot,
      dependencies: [
        { framework: "langchain", version: "0.3.27", usage: "library", internet_facing: true },
        { framework: "vllm", version: null, usage: "hosted", internet_facing: false },
      ],
    });

    const put = await replace(teamId, product.id, {
      name: "support bot",
      repo_urls: [],
      dependencies: [],
    });

    expect(put.status).toBe(200);
    expect(await list(teamId)).toEqual([
      { id: product.id, name: "support bot", repo_urls: [], dependencies: [] },
    ]);
  });

  it("stores versions and Repo URLs trimmed, so a line break never reaches the reasons or the UI", async () => {
    const teamId = await team();

    const product = await created(teamId, {
      ...supportBot,
      repo_urls: [" https://github.com/example/support-bot\n"],
      dependencies: [
        { framework: "langchain", version: "1.4.0\n", usage: "library", internet_facing: true },
        { framework: "vllm", version: " 0.6.1 ", usage: "hosted", internet_facing: false },
      ],
    });

    const versions = (products: Product[]) =>
      products.flatMap(({ dependencies }) => dependencies.map(({ version }) => version));
    expect(versions([product])).toEqual(["1.4.0", "0.6.1"]);
    expect(versions(await list(teamId))).toEqual(["1.4.0", "0.6.1"]);
    expect((await list(teamId))[0]!.repo_urls).toEqual(["https://github.com/example/support-bot"]);
  });

  // Bug slice 4 (#113's verifier): the store trims too, so a caller other than the route never stores a line break.
  it("has the store trim each version on create and update, for any caller", async () => {
    const teamId = await team();
    const store = createProducts({ withTeam });
    const dependency = (version: string) => ({
      framework: "langchain",
      version,
      usage: "library" as const,
      internet_facing: false,
    });

    const made = await store.create(teamId, {
      ...supportBot,
      dependencies: [dependency(" 2.0\n")],
    });
    const changed = await store.update(teamId, made.id, {
      ...supportBot,
      dependencies: [dependency("\t2.1 ")],
    });
    const { dependencies } = await stored(teamId);

    expect(made.dependencies.map(({ version }) => version)).toEqual(["2.0"]);
    expect(changed.dependencies.map(({ version }) => version)).toEqual(["2.1"]);
    expect(dependencies.map(({ version }) => version)).toEqual(["2.1"]);
  });
});

describe("a Member", () => {
  it("is refused creating, changing and deleting a Product, and nothing changes", async () => {
    const teamId = await team();
    const product = await created(teamId);
    const before = await list(teamId);

    const answers = [
      await create(teamId, { ...supportBot, name: "Member's app" }, MEMBER),
      await replace(teamId, product.id, { ...supportBot, name: "Renamed" }, MEMBER),
      await remove(teamId, product.id, MEMBER),
    ];

    expect(answers.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(await list(teamId)).toEqual(before);
  });
});

// POST and PUT read the body with one parser, so its cases run on POST, and one shows PUT refuses as well.
describe("a body Patch doesn't take", () => {
  it("answers 400 to a body that isn't JSON or that ProductInput refuses, and writes nothing", async () => {
    const teamId = await team();
    await created(teamId);
    const before = await stored(teamId);

    const answers = [
      await create(teamId, "{not json"),
      await create(teamId, { ...supportBot, name: "Other app", team: "org_other" }),
    ];

    expect(answers.map(({ status }) => status)).toEqual([400, 400]);
    expect(answers[1]!.body).toEqual({ error: expect.stringContaining("team") });
    expect(await stored(teamId)).toEqual(before);
  });

  // A name the Team doesn't have yet, so nothing in a case is a 409 instead.
  const otherApp: ProductInput = { ...supportBot, name: "Other app" };
  const dependency = (overrides: Partial<ProductInput["dependencies"][number]>) => ({
    ...otherApp,
    dependencies: [{ ...otherApp.dependencies[0]!, ...overrides }],
  });
  const refused: { input: string; body: ProductInput; field: string }[] = [
    {
      input: "a framework Patch doesn't know",
      body: dependency({ framework: "tensorflow" }),
      field: "dependencies.0.framework",
    },
    {
      input: "a Repo URL listed twice",
      body: {
        ...otherApp,
        repo_urls: ["https://github.com/example/a", "https://github.com/example/a"],
      },
      field: "repo_urls.1",
    },
    {
      input: "a Repo URL listed twice, once with spaces around it",
      body: {
        ...otherApp,
        repo_urls: ["https://github.com/example/a", " https://github.com/example/a\n"],
      },
      field: "repo_urls.1",
    },
    {
      input: "a version holding a space",
      body: dependency({ version: "1.0 beta" }),
      field: "dependencies.0.version",
    },
    {
      input: "a version that is only spaces",
      body: dependency({ version: "  \n" }),
      field: "dependencies.0.version",
    },
    // Postgres can't store a NUL in text, so it would otherwise be a 500.
    { input: "a NUL in the name", body: { ...otherApp, name: "Other\u0000app" }, field: "name" },
    {
      input: "a NUL in a Repo URL",
      body: { ...otherApp, repo_urls: ["https://github.com/example/a\u0000"] },
      field: "repo_urls.0",
    },
    {
      input: "a NUL in a version",
      body: dependency({ version: "1.0\u0000" }),
      field: "dependencies.0.version",
    },
  ];
  for (const { input, body, field } of refused) {
    it(`answers ${input} 400 naming ${field}, and writes nothing`, async () => {
      const teamId = await team();
      await created(teamId);
      const before = await stored(teamId);

      const answer = await create(teamId, body);

      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: expect.stringContaining(`${field}: `) });
      expect(await stored(teamId)).toEqual(before);
    });
  }

  it("answers a PUT the same parser refuses 400 too, and the Product is unchanged", async () => {
    const teamId = await team();
    const product = await created(teamId);
    const before = await stored(teamId);

    const answer = await replace(teamId, product.id, { ...supportBot, name: "Other\u0000app" });

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: expect.stringContaining("name: ") });
    expect(await stored(teamId)).toEqual(before);
  });
});

describe("a name another Product in the Team has", () => {
  // Which names clash (case, spaces) is the unique index's, proven on the table; a create's 409 is the race below.
  it("answers 409 to a rename onto it, and writes nothing", async () => {
    const teamId = await team();
    await created(teamId);
    const other = await created(teamId, { ...supportBot, name: "Other app" });
    const before = await stored(teamId);

    const answer = await replace(teamId, other.id, supportBot);

    expect(answer.status).toBe(409);
    expect(await stored(teamId)).toEqual(before);
  });

  it("lets a Product keep its own name with its case changed", async () => {
    const teamId = await team();
    const product = await created(teamId);

    const put = await replace(teamId, product.id, { ...supportBot, name: "Support Bot" });

    expect(put.status).toBe(200);
  });

  it("answers one of two creates sent at once 201 and the other 409, never a 500", async () => {
    const teamId = await team();

    const answers = await Promise.all([
      create(teamId, supportBot),
      create(teamId, { ...supportBot, name: "Support Bot" }),
    ]);

    expect(answers.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(await list(teamId)).toHaveLength(1);
  });
});

describe("a Product id the Team doesn't have", () => {
  it("answers PUT and DELETE 404 for an id that doesn't exist", async () => {
    const teamId = await team();

    const answers = [
      await replace(teamId, randomUUID(), supportBot),
      await remove(teamId, randomUUID()),
    ];

    expect(answers.map(({ status }) => status)).toEqual([404, 404]);
    expect(await stored(teamId)).toEqual({ products: [], dependencies: [] });
  });

  it("answers Team B's Lead 404 on Team A's Product, and Team A's Product is unchanged", async () => {
    const [a, b] = [await team(), await team()];
    const product = await created(a);
    const before = await list(a);

    const answers = [
      await replace(b, product.id, { ...supportBot, name: "Taken over" }),
      await remove(b, product.id),
    ];

    expect(answers.map(({ status }) => status)).toEqual([404, 404]);
    expect(await list(a)).toEqual(before);
    expect(await list(b)).toEqual([]);
  });

  // Bug slice 3 (#113's verifier): the NUL reached Postgres in the id, a 500.
  it("answers PUT and DELETE 404 for an id holding a NUL, and scans nothing", async () => {
    const teamId = await team();
    await created(teamId);
    const before = await stored(teamId);
    const { app: recorded, scanned } = scanRecorded();

    const answers = [
      await replace(teamId, "a%00b", supportBot, LEAD, recorded),
      await remove(teamId, "a%00b", LEAD, recorded),
    ];

    expect(answers.map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 404, body: { error: "No such Product" } },
      { status: 404, body: { error: "No such Product" } },
    ]);
    expect(scanned).toEqual([]);
    expect(await stored(teamId)).toEqual(before);
  });
});

// Story 3: a saved version is one its framework's ecosystems can read, so its CVE Findings get a real verdict.
describe("a version its framework can't read", () => {
  const product = (framework: string, version: string): ProductInput => ({
    name: `${framework} app`,
    repo_urls: [],
    dependencies: [{ framework, version, usage: "self_hosted", internet_facing: true }],
  });

  it("answers LangChain 'banana' 400 on POST and PUT, writes nothing and scans nothing", async () => {
    const teamId = await team();
    const { app: recorded, scanned } = scanRecorded();
    const kept = await created(teamId);
    const before = await stored(teamId);

    const answers = [
      await create(teamId, product("langchain", "banana"), LEAD, recorded),
      await replace(teamId, kept.id, product("langchain", "banana"), LEAD, recorded),
    ];

    const refusal =
      "dependencies.0.version: 'banana' isn't a PyPI (PEP 440) version, which LangChain uses. Example: 0.3.27.";
    expect(answers.map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 400, body: { error: refusal } },
      { status: 400, body: { error: refusal } },
    ]);
    expect(scanned).toEqual([]);
    expect(await stored(teamId)).toEqual(before);
  });

  it("takes a version each framework's ecosystem reads, and a plain one for a framework with no package data", async () => {
    const teamId = await team();

    const answers = [
      await create(teamId, product("ollama", "v0.1.2")),
      await create(teamId, product("langchain", "0.0.200")),
      await create(teamId, product("dify", "1.0.0")),
    ];

    expect(answers.map(({ status }) => status)).toEqual([201, 201, 201]);
  });

  it("answers Dify '1.0$' 400: it doesn't look like a version", async () => {
    const teamId = await team();

    const answer = await create(teamId, product("dify", "1.0$"));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      error: expect.stringContaining("dependencies.0.version: '1.0$' doesn't look like a version"),
    });
    expect(await stored(teamId)).toEqual({ products: [], dependencies: [] });
  });
});

// Story 8: each Team's saves are its own, with its own limit (the spec's secure default for a public URL).
describe("the save limit", () => {
  it("answers a Team's third save in a minute 429 with Retry-After, writing and scanning nothing; another Team still saves", async () => {
    const [a, b] = [await team(), await team()];
    const { app: limited, scanned } = scanRecorded(createSaveLimit({ max: 2 }));

    const made = await create(a, supportBot, LEAD, limited);
    expect(made.status).toBe(201);
    const product = Product.parse(made.body);
    const put = await replace(a, product.id, { ...supportBot, name: "Renamed" }, LEAD, limited);
    expect(put.status).toBe(200);
    const before = await stored(a);

    const third = await remove(a, product.id, LEAD, limited);

    expect(third.status).toBe(429);
    expect(third.retryAfter).toMatch(/^[1-9]\d*$/);
    expect(Number(third.retryAfter)).toBeLessThanOrEqual(60);
    expect(third.body).toEqual({ error: expect.any(String) });
    expect(await stored(a)).toEqual(before);
    expect(scanned).toEqual([product.id, product.id]);
    expect((await create(b, supportBot, LEAD, limited)).status).toBe(201);
  });

  it("doesn't count a Member's refused saves", async () => {
    const teamId = await team();
    const { app: limited } = scanRecorded(createSaveLimit({ max: 2 }));

    const refused = [
      await create(teamId, supportBot, MEMBER, limited),
      await create(teamId, supportBot, MEMBER, limited),
      await create(teamId, supportBot, MEMBER, limited),
    ];
    const saved = [
      await create(teamId, supportBot, LEAD, limited),
      await create(teamId, { ...supportBot, name: "Other app" }, LEAD, limited),
    ];

    expect(refused.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(saved.map(({ status }) => status)).toEqual([201, 201]);
  });
});
