/**
 * Patch's API, mounted by the start-up file behind the app's middleware (ADR 0005: shared code never imports it). The
 * Team is always the session's, never the request's.
 */
import { ProductInput, type FrameworksBody, type ProductsBody } from "@warden/contracts";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { ProductNameTaken, ProductNotFound } from "./errors.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import type { Products } from "./products.ts";

const FRAMEWORK_IDS = new Set(PATCH_FRAMEWORKS.map(({ id }) => id));

/**
 * A Product as a Lead sends it, with what the contracts can't check: each framework one Patch knows, each Repo URL
 * once, and each version one word once the spaces around it are trimmed (the store keeps it trimmed).
 */
const ProductChange = ProductInput.superRefine(({ repo_urls, dependencies }, ctx) => {
  repo_urls.forEach((url, i) => {
    const first = repo_urls.indexOf(url);
    if (first !== i) {
      ctx.addIssue({
        code: "custom",
        path: ["repo_urls", i],
        message: `the same Repo URL as repo_urls[${first}]: each Repo URL is listed once`,
      });
    }
  });
  dependencies.forEach(({ framework, version }, i) => {
    if (!FRAMEWORK_IDS.has(framework)) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencies", i, "framework"],
        message: `"${framework}" isn't a framework Patch knows: GET /api/patch/frameworks lists them`,
      });
    }
    if (version !== null && /\s/.test(version.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencies", i, "version"],
        message: "a version has no spaces in it, such as 1.4.0",
      });
    }
  });
});

/** Each refused field and why, as the Findings routes answer a body their schema refuses. */
function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

/** The request's Product, or the 400 that refuses it. A body that isn't JSON parses as undefined, which is refused. */
async function productBody(c: Context<AppEnv>): Promise<ProductInput | Response> {
  const parsed = ProductChange.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : c.json({ error: refusedBody(parsed.error) }, 400);
}

/** A store refusal's answer, with nothing written: 404 for an id the Team doesn't have, 409 for a name taken. */
function productRefusal(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof ProductNotFound) return c.json({ error: "No such Product" }, 404);
  if (error instanceof ProductNameTaken) return c.json({ error: error.message }, 409);
  throw error;
}

export function patchRoutes({ products }: { products: Products }): MountRoutes {
  return (app, requireRole) => {
    // Any person in the Team reads its Products (stories 1 and 2).
    app.get("/api/products", requireRole("member"), async (c) => {
      const team = c.get("team");
      return c.json({ team, products: await products.list(team) } satisfies ProductsBody);
    });

    // A Lead or an Admin creates, changes and deletes them (stories 1 and 2); a Member gets requireRole's 403.
    app.post("/api/products", requireRole("lead"), async (c) => {
      const input = await productBody(c);
      if (input instanceof Response) return input;
      try {
        return c.json(await products.create(c.get("team"), input), 201);
      } catch (error) {
        return productRefusal(c, error);
      }
    });

    // PUT replaces the whole Product: Repo URLs and dependencies left out are gone.
    app.put("/api/products/:id", requireRole("lead"), async (c) => {
      const input = await productBody(c);
      if (input instanceof Response) return input;
      try {
        return c.json(await products.update(c.get("team"), c.req.param("id"), input));
      } catch (error) {
        return productRefusal(c, error);
      }
    });

    app.delete("/api/products/:id", requireRole("lead"), async (c) => {
      try {
        await products.remove(c.get("team"), c.req.param("id"));
        return c.body(null, 204);
      } catch (error) {
        return productRefusal(c, error);
      }
    });

    // The frameworks a dependency can name, for the Products page.
    app.get("/api/patch/frameworks", requireRole("member"), (c) =>
      c.json({ frameworks: [...PATCH_FRAMEWORKS] } satisfies FrameworksBody),
    );
  };
}
