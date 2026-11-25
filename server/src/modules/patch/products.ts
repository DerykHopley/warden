/**
 * A Team's Products, through `withTeam` (ADR 0006): row-level security shows and accepts only the Team's rows, so no
 * query here filters by Team, and another Team's Product id reads as one that doesn't exist. Each change is one
 * transaction. The Role checks are the routes'.
 */
import { randomUUID } from "node:crypto";
import type { Product, ProductInput } from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import { isPgError } from "../../database.ts";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";
import { ProductNameTaken, ProductNotFound } from "./errors.ts";

/** 0008_products' unique index on a Product's name in its Team, whatever its case and the spaces around it. */
const NAME_KEY = "products_team_name_key";

export interface Products {
  /** Every Product of the Team, by name whatever its case, each with its dependencies by framework id. */
  list(team: string): Promise<Product[]>;
  /** A new Product with these fields. Throws ProductNameTaken for a name the Team already has. */
  create(team: string, input: ProductInput): Promise<Product>;
  /**
   * Replaces the Product's name, Repo URLs and every dependency. Throws ProductNotFound for an id the Team doesn't
   * have, ProductNameTaken for a name another of its Products has.
   */
  update(team: string, id: string, input: ProductInput): Promise<Product>;
  /** Deletes the Product and, by the table's cascade, its dependencies. Throws ProductNotFound as update does. */
  remove(team: string, id: string): Promise<void>;
}

/**
 * Each Product with its dependencies, a row per dependency; a Product with none comes as one row of nulls. Each read
 * is one statement, so a Product and its dependencies come from one snapshot: a change committed between two reads
 * can't split a Product from its rows.
 */
function productRows(tx: Transaction<Database>) {
  return tx
    .selectFrom("products as p")
    .leftJoin("product_dependencies as d", (join) =>
      join.onRef("d.team_id", "=", "p.team_id").onRef("d.product_id", "=", "p.id"),
    )
    .select([
      "p.id",
      "p.name",
      "p.repo_urls",
      "d.framework",
      "d.version",
      "d.usage",
      "d.internet_facing",
    ]);
}

type ProductRow = Awaited<ReturnType<ReturnType<typeof productRows>["execute"]>>[number];

/** The rows as Products, in the order each first appears. */
function grouped(rows: ProductRow[]): Product[] {
  const products = new Map<string, Product>();
  for (const { id, name, repo_urls, framework, version, usage, internet_facing } of rows) {
    let product = products.get(id);
    if (product === undefined) {
      product = { id, name, repo_urls, dependencies: [] };
      products.set(id, product);
    }
    // The join's nulls: a dependency row's own columns are never null but its version.
    if (framework !== null && usage !== null && internet_facing !== null) {
      product.dependencies.push({ framework, version, usage, internet_facing });
    }
  }
  return [...products.values()];
}

/** Every Product of the Team, by name whatever its case. */
async function readAll(tx: Transaction<Database>): Promise<Product[]> {
  const rows = await productRows(tx)
    // lower(name) is unique in the Team, so the order is total; how two names compare (accents, punctuation)
    // follows the database's collation, as the framework ids do.
    .orderBy(sql`lower(p.name)`)
    .orderBy("d.framework")
    .execute();
  return grouped(rows);
}

/** The one Product `id` as stored, read in the transaction that wrote it. */
async function readOne(tx: Transaction<Database>, id: string): Promise<Product> {
  const rows = await productRows(tx).where("p.id", "=", id).orderBy("d.framework").execute();
  const [product] = grouped(rows);
  if (product === undefined) throw new ProductNotFound(id);
  return product;
}

/** The Product's dependency rows, each version as the routes give it (trimmed). */
async function writeDependencies(
  tx: Transaction<Database>,
  team: string,
  id: string,
  { dependencies }: ProductInput,
) {
  if (dependencies.length === 0) return;
  await tx
    .insertInto("product_dependencies")
    .values(dependencies.map((dependency) => ({ team_id: team, product_id: id, ...dependency })))
    .execute();
}

export function createProducts({ withTeam }: { withTeam: WithTeam }): Products {
  /** `withTeam`, with the name index's refusal (on create or rename) as ProductNameTaken. */
  async function withNameCheck<T>(
    team: string,
    { name }: ProductInput,
    work: (tx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTeam(team, work);
    } catch (error) {
      if (isPgError(error, "23505") && error.constraint === NAME_KEY)
        throw new ProductNameTaken(name);
      throw error;
    }
  }

  return {
    list: (team) => withTeam(team, readAll),

    create: (team, input) =>
      withNameCheck(team, input, async (tx) => {
        const id = randomUUID();
        await tx
          .insertInto("products")
          .values({ team_id: team, id, name: input.name, repo_urls: input.repo_urls })
          .execute();
        await writeDependencies(tx, team, id, input);
        return readOne(tx, id);
      }),

    update: (team, id, input) =>
      withNameCheck(team, input, async (tx) => {
        const updated = await tx
          .updateTable("products")
          .set({ name: input.name, repo_urls: input.repo_urls })
          .where("id", "=", id)
          .returning("id")
          .executeTakeFirst();
        if (updated === undefined) throw new ProductNotFound(id);
        await tx.deleteFrom("product_dependencies").where("product_id", "=", id).execute();
        await writeDependencies(tx, team, id, input);
        return readOne(tx, id);
      }),

    remove: (team, id) =>
      withTeam(team, async (tx) => {
        const deleted = await tx
          .deleteFrom("products")
          .where("id", "=", id)
          .returning("id")
          .executeTakeFirst();
        if (deleted === undefined) throw new ProductNotFound(id);
      }),
  };
}
