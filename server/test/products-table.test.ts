// Story 8 at the database: a Team's Products and their dependencies (0008_products) are Team-owned under forced
// row-level security, so a query that forgets the Team still reads only its own rows (ADR 0006). The tables' own rules
// hold too: a name is unique in a Team whatever its case, a framework appears once per Product, a usage is one of
// Usage's values, and deleting a Product deletes its dependencies. As warden_app, on the suite's migrated database,
// with Teams of this file's own.
import { randomUUID } from "node:crypto";
import type { ProductDependency } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { seedProduct } from "./helpers.ts";

const A = `org_products_a_${randomUUID()}`;
const B = `org_products_b_${randomUUID()}`;
let pool: pg.Pool;
let withTeam: WithTeam;

/** How every Product here uses `framework`. */
const uses = (framework: string): ProductDependency => ({
  framework,
  version: "0.3.27",
  usage: "library",
  internet_facing: true,
});

/** A product_dependencies row, as an insert writes it. */
const dependency = (team: string, productId: string, framework = "langchain") => ({
  team_id: team,
  product_id: productId,
  ...uses(framework),
});

/** A Product of `team`'s, with one dependency per framework named. */
const product = (team: string, name: string, frameworks: string[] = ["langchain"]) =>
  seedProduct(withTeam, team, { name, dependencies: frameworks.map(uses) });

let aProduct: string;
let bProducts: string[];

beforeAll(async () => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  for (const team of [A, B]) {
    await withTeam(team, (tx) => tx.insertInto("teams").values({ id: team }).execute());
  }
  aProduct = await product(A, "Team A's app", ["langchain", "vllm"]);
  bProducts = [await product(B, "Team B's app"), await product(B, "Team B's bot", ["ollama"])];
});

afterAll(() => pool.end());

describe("a Team's Products are kept apart", () => {
  it("a query on either table with no Team filter returns only the Team's rows", async () => {
    const seen = await withTeam(B, async (tx) => ({
      products: await tx.selectFrom("products").select(["team_id", "id"]).execute(),
      dependencies: await tx
        .selectFrom("product_dependencies")
        .select(["team_id", "product_id"])
        .execute(),
    }));

    expect(seen.products.map((row) => row.id).sort()).toEqual([...bProducts].sort());
    expect(new Set(seen.products.map((row) => row.team_id))).toEqual(new Set([B]));
    expect(seen.dependencies).toHaveLength(2);
    expect(new Set(seen.dependencies.map((row) => row.team_id))).toEqual(new Set([B]));
  });

  it("an insert into either table carrying another Team's team_id is refused", async () => {
    await expect(
      withTeam(B, (tx) =>
        tx
          .insertInto("products")
          .values({ team_id: A, id: randomUUID(), name: "Planted", repo_urls: [] })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTeam(B, (tx) =>
        tx
          .insertInto("product_dependencies")
          .values(dependency(A, aProduct, "gradio"))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("the Products tables refuse", () => {
  it("a second Product whose name differs only in case, or in the spaces around it", async () => {
    await product(A, "Checkout");

    await expect(product(A, "CHECKOUT")).rejects.toThrow(/products_team_name_key/);
    await expect(product(A, " checkout  ")).rejects.toThrow(/products_team_name_key/);
    // Another Team may use the name.
    await expect(product(B, "checkout")).resolves.toBeTypeOf("string");
  });

  it("a second row for the same framework on one Product", async () => {
    await expect(
      withTeam(A, (tx) =>
        tx.insertInto("product_dependencies").values(dependency(A, aProduct)).execute(),
      ),
    ).rejects.toThrow(/product_dependencies_pkey/);
  });

  it("a usage outside Usage's values", async () => {
    await expect(
      withTeam(A, (tx) =>
        tx
          .insertInto("product_dependencies")
          .values({ ...dependency(A, aProduct, "gradio"), usage: "vendored" as "library" })
          .execute(),
      ),
    ).rejects.toThrow(/product_dependencies_usage_check/);
  });
});

it("deleting a Product deletes its dependencies", async () => {
  const id = await product(A, "Short-lived", ["langchain", "gradio", "litellm"]);
  const dependencies = () =>
    withTeam(A, (tx) =>
      tx
        .selectFrom("product_dependencies")
        .select("framework")
        .where("product_id", "=", id)
        .execute(),
    );
  expect(await dependencies()).toHaveLength(3);

  await withTeam(A, (tx) => tx.deleteFrom("products").where("id", "=", id).execute());

  expect(await dependencies()).toEqual([]);
});
