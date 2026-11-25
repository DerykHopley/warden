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
        const products = await tx
          .selectFrom("products")
          .select(["id", "name", "repo_urls"])
          // Unique in the Team, so the order is total, and the same whatever the database's collation.
          .orderBy(sql`lower(name)`)
          .execute();
        const dependencies = await tx
          .selectFrom("product_dependencies")
          .select(["product_id", "framework", "version", "usage", "internet_facing"])
          .orderBy("framework")
          .execute();
        return products.map((product) => ({
          ...product,
          dependencies: dependencies
            .filter((dependency) => dependency.product_id === product.id)
            .map(({ framework, version, usage, internet_facing }) => ({
              framework,
              version,
              usage,
              internet_facing,
            })),
        }));
      }),
  };
}
