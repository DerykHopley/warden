// A Team's Products and Patch's frameworks, as the API answers and takes them (Patch, spec #101). A Product is what a
// Team ships: its name, its Repo URLs, and the frameworks it uses. The Team comes from the session, never the body.
import { z } from "zod";
import { Id, Text } from "./finding.ts";

/**
 * How a Product uses a framework: Patch's verdict.py values, which decide who acts on a CVE. The one place they live:
 * the Patch module and the database's check constraint follow this list.
 */
export const Usage = z.enum(["self_hosted", "library", "transitive", "hosted"]);
export type Usage = z.infer<typeof Usage>;

/** One framework a Product uses: its version (null when unknown), how it's used, and whether it faces the internet. */
export const ProductDependency = z.strictObject({
  /** A framework id from `GET /api/patch/frameworks`. */
  framework: Id,
  version: Text(100).nullable(),
  usage: Usage,
  internet_facing: z.boolean(),
});
export type ProductDependency = z.infer<typeof ProductDependency>;

/** A Repo URL: https only. Stored as text; nothing links it to a Guard Repo Asset yet. */
const RepoUrl = z.url({ protocol: /^https$/ }).max(2000);

/** What a Lead sends to create or change a Product: at most 20 Repo URLs, and one row per framework it uses. */
export const ProductInput = z.strictObject({
  name: Text(200),
  repo_urls: z.array(RepoUrl).max(20),
  dependencies: z.array(ProductDependency),
});
export type ProductInput = z.infer<typeof ProductInput>;

/** A stored Product: its id (the Asset ref its Findings carry, so a rename keeps them) and its fields. */
export const Product = z.strictObject({ id: Id, ...ProductInput.shape });
export type Product = z.infer<typeof Product>;

/** `GET /api/products`: every Product of the session's Team, by name. */
export const ProductsBody = z.strictObject({ team: Id, products: z.array(Product) });
export type ProductsBody = z.infer<typeof ProductsBody>;

/** What OSV has for a framework: package version ranges, code commits only, or nothing. */
export const Coverage = z.enum(["package", "commits", "none"]);
export type Coverage = z.infer<typeof Coverage>;

/** A framework Patch knows: its id, display name, OSV packages as purls without a version, and its OSV coverage. */
export const Framework = z.strictObject({
  id: Id,
  name: Text(200),
  purls: z.array(z.string().regex(/^pkg:[a-z]+\/\S+$/)),
  coverage: Coverage,
});
export type Framework = z.infer<typeof Framework>;

/** `GET /api/patch/frameworks`: every framework a Product's dependency can name. */
export const FrameworksBody = z.strictObject({ frameworks: z.array(Framework) });
export type FrameworksBody = z.infer<typeof FrameworksBody>;
