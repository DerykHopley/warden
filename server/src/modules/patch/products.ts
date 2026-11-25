/**
 * A Team's Products, through `withTeam` (ADR 0006): row-level security shows only the Team's rows, so no query here
 * filters by Team. Reads only for now; creating, changing and deleting come with their Role checks (#113).
 */
import type { Product } from "@warden/contracts";
import { sql } from "kysely";
import type { WithTeam } from "../../with-team.ts";

export interface Products {
  /** Every Product of the Team, by name whatever its case, each with its dependencies by framework id. */
  list(team: string): Promise<Product[]>;
}

export function createProducts({ withTeam }: { withTeam: WithTeam }): Products {
  return {
    list: (team) =>
      withTeam(team, async (tx) => {
        // One statement, so the Products and their dependencies come from one snapshot: a change committed between
        // two reads can't split a Product from its rows. A Product with no dependencies comes as one row of nulls.
        const rows = await tx
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
          ])
          // lower(name) is unique in the Team, so the order is total; how two names compare (accents, punctuation)
          // follows the database's collation, as the framework ids do.
          .orderBy(sql`lower(p.name)`)
          .orderBy("d.framework")
          .execute();
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
      }),
  };
}
