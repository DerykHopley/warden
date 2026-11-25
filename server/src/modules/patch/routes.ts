/**
 * Patch's API, mounted by the start-up file behind the app's middleware (ADR 0005: shared code never imports it). The
 * Team is always the session's, never the request's.
 */
import {
  PatchAssessment,
  ProductInput,
  type FrameworksBody,
  type Product,
  type ProductsBody,
} from "@warden/contracts";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { AppEnv, MountRoutes } from "../../app.ts";
import type { Logger } from "../../log.ts";
import type { PatchAssessments } from "./assessment.ts";
import {
  CveNotInSnapshot,
  PatchFindingNotFound,
  ProductNameTaken,
  ProductNotFound,
  VersionRefused,
} from "./errors.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import type { Products } from "./products.ts";
import type { SaveLimit } from "./save-limit.ts";
import { purlEcosystem, type PatchScan } from "./scan.ts";
import { checkVersion } from "./verdict.ts";

/**
 * Each framework Patch knows, by id: its display name, and the ecosystems its purls are in, in the shape
 * `checkVersion` reads. A purl in no ecosystem Patch has version rules for stops start-up, as the frameworks are
 * fixed data.
 */
const FRAMEWORKS = new Map(
  PATCH_FRAMEWORKS.map(({ id, name, purls }) => [
    id,
    {
      name,
      osv: {
        packages: purls.map((purl) => {
          const ecosystem = purlEcosystem(purl);
          if (ecosystem === undefined) {
            throw new Error(`${id}'s purl ${purl} is in no ecosystem Patch has version rules for`);
          }
          return { ecosystem };
        }),
      },
    },
  ]),
);

/** Postgres can't store a NUL in text and would refuse the write as a 500, so a field holding one is a 400. */
const NUL_MESSAGE = "holds a NUL character, which Warden can't store";

/**
 * A Product as a Lead sends it, with what the contracts can't check: each framework one Patch knows, each Repo URL
 * once, each version one word its framework's ecosystems can read (`checkVersion`; a framework with no package data
 * takes a plain version), and no NUL in anything stored. Each version is trimmed here before it's checked, so
 * `" 2.0\n"` is one word; the store trims it again, for callers that don't come through these routes (the daily step,
 * the seed). One of only whitespace is already refused by the contract's Text. Repo URLs come trimmed from the
 * contract's URL check, so `" https://…/a\n"` repeats `"https://…/a"`.
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
    const known = FRAMEWORKS.get(framework);
    if (known === undefined) {
      refuse(
        ["dependencies", i, "framework"],
        `"${framework}" isn't a framework Patch knows: GET /api/patch/frameworks lists them`,
      );
    }
    if (version === null) return;
    if (/\s/.test(version)) {
      return refuse(["dependencies", i, "version"], "a version has no spaces in it, such as 1.4.0");
    }
    if (version.includes("\0")) return refuse(["dependencies", i, "version"], NUL_MESSAGE);
    if (known === undefined) return;
    try {
      checkVersion(known.osv, known.name, version);
    } catch (error) {
      if (!(error instanceof VersionRefused)) throw error;
      refuse(["dependencies", i, "version"], error.message);
    }
  });
});

/** Each refused field and why, as the Findings routes answer a body their schema refuses. */
function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

/**
 * The answer `work` gives, or its refusal, with nothing written: 404 for a Product or a Patch Finding the Team doesn't
 * have (naming nothing of anyone's) and for a CVE the loaded snapshot doesn't hold (naming that CVE), 409 for a name
 * taken.
 */
async function refusing(c: Context<AppEnv>, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProductNotFound) return c.json({ error: "No such Product" }, 404);
    if (error instanceof PatchFindingNotFound) {
      return c.json({ error: "No such Patch Finding" }, 404);
    }
    if (error instanceof CveNotInSnapshot) return c.json({ error: error.message }, 404);
    if (error instanceof ProductNameTaken) return c.json({ error: error.message }, 409);
    throw error;
  }
}

/**
 * The path's Product id. One holding a NUL is no Product's id (Postgres can't store a NUL in text, and would refuse
 * the read as a 500), so it's ProductNotFound before the store sees it: the same 404 as an id the Team doesn't have.
 */
function productId(c: Context<AppEnv>): string {
  const id = c.req.param("id") ?? "";
  if (id.includes("\0")) throw new ProductNotFound(id);
  return id;
}

/** The path's Finding id: one holding a NUL is no Finding's id, so it's PatchFindingNotFound, as `productId` does. */
function findingId(c: Context<AppEnv>): string {
  const id = c.req.param("id") ?? "";
  if (id.includes("\0")) throw new PatchFindingNotFound(id);
  return id;
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
 * open and turn Fixed with the change (stories 3 and 4). The Scan reads the Product as stored, so two close changes
 * end with the newer one's Findings. A Scan that throws leaves the change standing and answering as usual: `logger`
 * records it, and the daily refresh catches the Product up. After a DELETE there's no Product row left to refresh:
 * the daily refresh sweeps each Product Asset with Open Findings and no Product row instead.
 *
 * `saveLimit` counts each Team's saves (POST, PUT and DELETE together) once requireRole has let the request through,
 * so a Member's 403 never counts; a save past it is a 429 with Retry-After, before the body is read, so nothing is
 * written and nothing scanned. Reads, the assessment included, aren't counted.
 */
export function patchRoutes({
  products,
  scan,
  assessment,
  logger,
  saveLimit,
}: {
  products: Products;
  scan: PatchScan;
  assessment: PatchAssessments;
  logger: Logger;
  saveLimit: SaveLimit;
}): MountRoutes {
  const limited: MiddlewareHandler<AppEnv> = async (c, next) => {
    const retryAfter = saveLimit.attempt(c.get("team"));
    if (retryAfter !== undefined) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many Product saves: try again in a minute" }, 429);
    }
    await next();
  };

  async function scanAfterChange(team: string, product: Pick<Product, "id">) {
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
    app.post("/api/products", requireRole("lead"), limited, (c) =>
      withProduct(c, async (input) => {
        const product = await products.create(c.get("team"), input);
        await scanAfterChange(c.get("team"), product);
        return c.json(product, 201);
      }),
    );

    // PUT replaces the whole Product: Repo URLs and dependencies left out are gone.
    app.put("/api/products/:id", requireRole("lead"), limited, (c) =>
      withProduct(c, async (input) => {
        const product = await products.update(c.get("team"), productId(c), input);
        await scanAfterChange(c.get("team"), product);
        return c.json(product);
      }),
    );

    // A deleted Product's Scan reads no dependencies, so every Finding on it turns Fixed. If that Scan fails, the
    // daily refresh's sweep of Product Assets with Open Findings and no Product row turns them Fixed.
    app.delete("/api/products/:id", requireRole("lead"), limited, (c) =>
      refusing(c, async () => {
        const id = productId(c);
        await products.remove(c.get("team"), id);
        await scanAfterChange(c.get("team"), { id });
        return c.body(null, 204);
      }),
    );

    // The frameworks a dependency can name, for the Products page.
    app.get("/api/patch/frameworks", requireRole("member"), (c) =>
      c.json({ frameworks: [...PATCH_FRAMEWORKS] } satisfies FrameworksBody),
    );

    // Any person in the Team reads one Patch Finding's assessment, worked out now (stories 5 and 6). An id that isn't
    // one of the Team's Patch Findings is a 404 naming nothing of anyone's (story 8); so is a CVE the loaded snapshot
    // doesn't hold, naming that CVE. The answer is parsed, not only typed, so its Text limits and URLs hold at run time.
    app.get("/api/patch/findings/:id/assessment", requireRole("member"), (c) =>
      refusing(c, async () =>
        c.json(PatchAssessment.parse(await assessment.read(c.get("team"), findingId(c)))),
      ),
    );
  };
}
