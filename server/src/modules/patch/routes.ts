/**
 * Patch's API, mounted by the start-up file behind the app's middleware (ADR 0005: shared code never imports it). The
 * Team is always the session's, never the request's.
 */
import {
  ProductInput,
  type FrameworksBody,
  type Product,
  type ProductsBody,
} from "@warden/contracts";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv, MountRoutes } from "../../app.ts";
import type { Logger } from "../../log.ts";
import { ProductNameTaken, ProductNotFound } from "./errors.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import type { Products } from "./products.ts";
import type { PatchScan } from "./scan.ts";

const FRAMEWORK_IDS = new Set(PATCH_FRAMEWORKS.map(({ id }) => id));

/** Postgres can't store a NUL in text and would refuse the write as a 500, so a field holding one is a 400. */
const NUL_MESSAGE = "holds a NUL character, which Warden can't store";

/**
 * A Product as a Lead sends it, with what the contracts can't check: each framework one Patch knows, each Repo URL
 * once, each version one word, and no NUL in anything stored. Each version is trimmed here and only here, so a line
 * break never reaches the reasons or the UI; one of only whitespace is already refused by the contract's Text. Repo
 * URLs come trimmed from the contract's URL check, so `" https://…/a\n"` repeats `"https://…/a"`.
 */
const ProductChange = ProductInput.transform(({ dependencies, ...product }): ProductInput => ({
  ...product,
  dependencies: dependencies.map(({ version, ...dependency }) => ({
    ...dependency,
    version: version?.trim() ?? null,
  })),
})).superRefine(({ name, repo_urls, dependencies }, ctx) => {
  const refuse = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if (name.includes("\0")) refuse(["name"], NUL_MESSAGE);
  repo_urls.forEach((url, i) => {
    if (url.includes("\0")) refuse(["repo_urls", i], NUL_MESSAGE);
    const first = repo_urls.indexOf(url);
    if (first !== i) {
      refuse(
        ["repo_urls", i],
        `the same Repo URL as repo_urls[${first}]: each Repo URL is listed once`,
      );
    }
  });
  dependencies.forEach(({ framework, version }, i) => {
    if (!FRAMEWORK_IDS.has(framework)) {
      refuse(
        ["dependencies", i, "framework"],
        `"${framework}" isn't a framework Patch knows: GET /api/patch/frameworks lists them`,
      );
    }
    if (version === null) return;
    if (/\s/.test(version)) {
      refuse(["dependencies", i, "version"], "a version has no spaces in it, such as 1.4.0");
    }
    if (version.includes("\0")) refuse(["dependencies", i, "version"], NUL_MESSAGE);
  });
});

/** Each refused field and why, as the Findings routes answer a body their schema refuses. */
function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

/**
 * The answer `work` gives, or the store's refusal of it, with nothing written: 404 for an id the Team doesn't have,
 * 409 for a name taken.
 */
async function refusing(c: Context<AppEnv>, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProductNotFound) return c.json({ error: "No such Product" }, 404);
    if (error instanceof ProductNameTaken) return c.json({ error: error.message }, 409);
    throw error;
  }
}

/**
 * `refusing`, with `work` given the request's Product. A body that isn't JSON (read as undefined) or that
 * ProductChange refuses is a 400, before any write.
 */
async function withProduct(
  c: Context<AppEnv>,
  work: (input: ProductInput) => Promise<Response>,
): Promise<Response> {
  const parsed = ProductChange.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
  return refusing(c, () => work(parsed.data));
}

/**
 * Patch's routes. After a Product's change commits, `scan` runs its Patch Scan before the answer, so its CVE Findings
 * open and turn Fixed with the change (stories 3 and 4). A Scan that throws leaves the change standing and answering
 * as usual: `logger` records it, and the daily refresh catches the Product up.
 */
export function patchRoutes({
  products,
  scan,
  logger,
}: {
  products: Products;
  scan: PatchScan;
  logger: Logger;
}): MountRoutes {
  async function scanAfterChange(team: string, product: Pick<Product, "id" | "dependencies">) {
    try {
      await scan.scanProduct(team, product);
    } catch (error) {
      logger.error("the Patch Scan after a Product change failed; the change stands", {
        team,
        productId: product.id,
        error,
      });
    }
  }

  return (app, requireRole) => {
    // Any person in the Team reads its Products (stories 1 and 2).
    app.get("/api/products", requireRole("member"), async (c) => {
      const team = c.get("team");
      return c.json({ team, products: await products.list(team) } satisfies ProductsBody);
    });

    // A Lead or an Admin creates, changes and deletes them (stories 1 and 2); a Member gets requireRole's 403.
    // Each change's Scan runs only once the store has written it: a refused change (400, 404, 409) scans nothing.
    app.post("/api/products", requireRole("lead"), (c) =>
      withProduct(c, async (input) => {
        const product = await products.create(c.get("team"), input);
        await scanAfterChange(c.get("team"), product);
        return c.json(product, 201);
      }),
    );

    // PUT replaces the whole Product: Repo URLs and dependencies left out are gone.
    app.put("/api/products/:id", requireRole("lead"), (c) =>
      withProduct(c, async (input) => {
        const product = await products.update(c.get("team"), c.req.param("id"), input);
        await scanAfterChange(c.get("team"), product);
        return c.json(product);
      }),
    );

    // A deleted Product is scanned with no dependencies, so every Finding on it turns Fixed.
    app.delete("/api/products/:id", requireRole("lead"), (c) =>
      refusing(c, async () => {
        const id = c.req.param("id");
        await products.remove(c.get("team"), id);
        await scanAfterChange(c.get("team"), { id, dependencies: [] });
        return c.body(null, 204);
      }),
    );

    // The frameworks a dependency can name, for the Products page.
    app.get("/api/patch/frameworks", requireRole("member"), (c) =>
      c.json({ frameworks: [...PATCH_FRAMEWORKS] } satisfies FrameworksBody),
    );
  };
}
