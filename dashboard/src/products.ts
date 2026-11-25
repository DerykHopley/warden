// The Team's Products (GET /api/products) and the frameworks Patch knows (GET /api/patch/frameworks), for the
// Products page, and the words it shows for a dependency's usage.
import { FrameworksBody, ProductsBody, type Framework, type Usage } from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

export type ProductsResult =
  /** The Products of `team`, the Team the server answered about, by name. */
  | ({ kind: "products" } & ProductsBody)
  /** 403: the session has no Team (its active Organization went away). */
  | { kind: "no-team" }
  /** 409: the Team's Admin hasn't opened Warden yet. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchProducts(getToken: GetToken): Promise<ProductsResult> {
  const res = await callWarden(getToken, "/api/products");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, ProductsBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "products", ...body };
}

export type FrameworksResult = { kind: "frameworks"; frameworks: Framework[] } | Refused;

export async function fetchFrameworks(getToken: GetToken): Promise<FrameworksResult> {
  const res = await callWarden(getToken, "/api/patch/frameworks");
  if (!(res instanceof Response)) return res;
  const body = await parsed(res, FrameworksBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "frameworks", ...body };
}

/** How a Product uses a framework, in words. */
export const USAGE_WORDS: Record<Usage, string> = {
  self_hosted: "Self-hosted",
  library: "Library",
  transitive: "Through another package",
  hosted: "Hosted",
};
