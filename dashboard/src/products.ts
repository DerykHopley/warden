// The Team's Products (GET /api/products), the frameworks Patch knows (GET /api/patch/frameworks) and a Product's save
// (POST or PUT, once /api/me confirms the session's Team), for the Products page, and the words it shows for a
// dependency's usage.
import {
  FrameworksBody,
  Product,
  ProductsBody,
  type Framework,
  type ProductInput,
  type Usage,
} from "@warden/contracts";
import {
  askAboutTeam,
  callWarden,
  parsed,
  serverError,
  type GetToken,
  type Refused,
} from "./api.ts";
import { fetchMe, type MeResult } from "./me.ts";

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

/** A save's answer: the Product as stored, or why the server refused it. */
export type SaveResult =
  | { kind: "saved"; product: Product }
  /** 400: `ProductChange` refused the body; `error` names each field (the server's words as they are). */
  | { kind: "invalid"; error: string | null }
  /** 403: the person's Role is too low (or was lowered), or they have no Team. */
  | { kind: "forbidden" }
  /** 404 (a change): the Team has no Product with that id. */
  | { kind: "not-found" }
  /** 409: the name is taken, or the Team isn't opened; `error` is the server's words, null when its body has none. */
  | { kind: "conflict"; error: string | null }
  /** No answer, or a 2xx whose body isn't a Product: the change may have been saved. */
  | { kind: "maybe-saved" }
  | Exclude<Refused, { kind: "not-answering" }>;

/**
 * Creates a Product (`id` null: POST /api/products) or replaces the Product `id` whole (PUT /api/products/:id). The
 * server checks the Role and runs the Product's Patch Scan before it answers.
 */
export async function saveProduct(
  getToken: GetToken,
  id: string | null,
  input: ProductInput,
): Promise<SaveResult> {
  const res = await callWarden(
    getToken,
    id === null ? "/api/products" : `/api/products/${encodeURIComponent(id)}`,
    { method: id === null ? "POST" : "PUT", body: input },
  );
  if (!(res instanceof Response))
    return res.kind === "not-answering" ? { kind: "maybe-saved" } : res;
  switch (res.status) {
    case 400:
      return { kind: "invalid", error: await serverError(res) };
    case 403:
      return { kind: "forbidden" };
    case 404:
      return { kind: "not-found" };
    case 409:
      return { kind: "conflict", error: await serverError(res) };
  }
  const product = await parsed(res, Product);
  return product === undefined ? { kind: "maybe-saved" } : { kind: "saved", product };
}

/**
 * Asks /api/me as reads ask (`askAboutTeam`) until it says the session is in `team`, and hands back the token that
 * answer was asked with, as a `GetToken` for the change: Clerk can still hand out a token for the Team just left, and
 * the server takes the Team from the token, so a change sent with a token taken after the check could land in another
 * Team. Each try takes a fresh token; only the one from the try that named `team` is kept. While /api/me names another
 * Team, or gives no answer, its answer comes back instead.
 */
export async function confirmTeam(
  getToken: GetToken,
  team: string | null,
): Promise<{ kind: "confirmed"; getToken: GetToken } | Exclude<MeResult, { kind: "signed-in" }>> {
  let token: string | null = null;
  const session = await askAboutTeam(
    () =>
      fetchMe(async () => {
        token = await getToken();
        return token;
      }),
    (result) => (result.kind === "signed-in" ? result.team : undefined),
    team,
    new AbortController().signal,
  );
  if (session.kind !== "signed-in") return session;
  const confirmed = token;
  return { kind: "confirmed", getToken: () => Promise.resolve(confirmed) };
}

/**
 * Saves as `saveProduct` does, but only once /api/me says the session is in `team`, the Team the form was opened in,
 * and with the token that answer was asked with (`confirmTeam`); while it names another Team, or gives no answer,
 * nothing is sent.
 */
export async function saveProductInTeam(
  getToken: GetToken,
  team: string | null,
  id: string | null,
  input: ProductInput,
): Promise<SaveResult | Exclude<MeResult, { kind: "signed-in" }>> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  return saveProduct(inTeam.getToken, id, input);
}

/** How a Product uses a framework, in words. */
export const USAGE_WORDS: Record<Usage, string> = {
  self_hosted: "Self-hosted",
  library: "Library",
  transitive: "Through another package",
  hosted: "Hosted",
};
