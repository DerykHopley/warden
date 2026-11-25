/**
 * Patch's API, mounted by the start-up file behind the app's middleware (ADR 0005: shared code never imports it). The
 * Team is always the session's, never the request's.
 */
import type { FrameworksBody, ProductsBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import type { Products } from "./products.ts";

export function patchRoutes({ products }: { products: Products }): MountRoutes {
  return (app, requireRole) => {
    // Any person in the Team reads its Products (stories 1 and 2); changing them is a Lead's (#113).
    app.get("/api/products", requireRole("member"), async (c) => {
      const team = c.get("team");
      return c.json({ team, products: await products.list(team) } satisfies ProductsBody);
    });

    // The frameworks a dependency can name, for the Products page.
    app.get("/api/patch/frameworks", requireRole("member"), (c) =>
      c.json({ frameworks: [...PATCH_FRAMEWORKS] } satisfies FrameworksBody),
    );
  };
}
