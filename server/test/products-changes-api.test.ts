// Stories 1, 2 and 8 at the API, changing Products: a Lead or an Admin creates, changes and deletes the Team's
// Products, a Member is refused, and no Team changes another's. Through the real app with Patch's routes mounted as the
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
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  patchMount,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

const MEMBER = "user_member";
const LEAD = "user_lead";
const ADMIN = "user_admin";

let key: CryptoKey;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  const { privateKey, publicPem } = await testKey();
  key = privateKey;
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({ publicPem, withTeam, mount: patchMount(withTeam) }));
});

afterAll(() => pool.end());

async function team() {
  const id = `org_${randomUUID()}`;
  await seedTeam(withTeam, id, [
    [MEMBER, "member"],
    [LEAD, "lead"],
    [ADMIN, "admin"],
  ]);
  return id;
}

/** A request as `as` in `teamId`: `body` sent as JSON, or as it is when it's already a string. */
async function call(
  method: string,
  path: string,
  { as, teamId, body }: { as: string; teamId: string; body?: unknown },
) {
  const token = await sessionToken(key, as, 60, activeOrganization(teamId));
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

const create = (teamId: string, body: unknown, as = LEAD) =>
  call("POST", "/api/products", { as, teamId, body });
const replace = (teamId: string, id: string, body: unknown, as = LEAD) =>
  call("PUT", `/api/products/${id}`, { as, teamId, body });
const remove = (teamId: string, id: string, as = LEAD) =>
  call("DELETE", `/api/products/${id}`, { as, teamId });

async function list(teamId: string) {
  const { status, body } = await call("GET", "/api/products", { as: MEMBER, teamId });
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
});
