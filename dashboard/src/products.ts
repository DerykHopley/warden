// The Team's Products (GET /api/products), the frameworks Patch knows (GET /api/patch/frameworks) and a Product's save
// (POST or PUT) and delete (DELETE), each once /api/me confirms the session's Team, for the Products page, and the
// words it shows for a dependency's usage.
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

/** The Team's Products, as `fetchProducts` answers; an answer about a Team other than `team` is asked again. */
export const askProducts = (getToken: GetToken, team: string | null, signal: AbortSignal) =>
  askAboutTeam(
    () => fetchProducts(getToken),
    (result) => (result.kind === "products" ? result.team : undefined),
    team,
    signal,
  );

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
  /**
   * No answer (`answered` false), or a 2xx whose body isn't a Product (`answered` true): the change may have been
   * saved.
   */
  | { kind: "maybe-saved"; answered: boolean }
  | Exclude<Refused, { kind: "not-answering" }>;

/**
 * Whether a save's answer may mean a Product was stored, so the list should be read again. The Products page's
 * `switch` on a save's answer follows the same rule: its "saved" and "maybe-saved" cases both read the list again.
 */
export function mayHaveStored(result: SaveResult | TeamCheckRefused): boolean {
  return result.kind === "saved" || result.kind === "maybe-saved";
}

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
    return res.kind === "not-answering" ? { kind: "maybe-saved", answered: false } : res;
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
  return product === undefined
    ? { kind: "maybe-saved", answered: true }
    : { kind: "saved", product };
}

/**
 * Why the Team check didn't confirm the Team: /api/me's own answer, with its 429 told apart as `too-many-sign-ins`,
 * since /api/me counts sign-ins, not changes to Products.
 */
export type TeamCheckRefused =
  | Exclude<MeResult, { kind: "signed-in" | "too-many-attempts" }>
  | { kind: "too-many-sign-ins"; retryAfter: number | null };

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
): Promise<{ kind: "confirmed"; getToken: GetToken } | TeamCheckRefused> {
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
  if (session.kind === "too-many-attempts")
    return { kind: "too-many-sign-ins", retryAfter: session.retryAfter };
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
): Promise<SaveResult | TeamCheckRefused> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  return saveProduct(inTeam.getToken, id, input);
}

/** A delete's answer: the Product is gone, or why the server refused it. */
export type DeleteResult =
  | { kind: "deleted" }
  /** 403: the person's Role is too low (or was lowered), or they have no Team. */
  | { kind: "forbidden" }
  /** 404: the Team has no Product with that id (another delete may have got there first). */
  | { kind: "not-found" }
  /** 409: the Team isn't opened; `error` is the server's words, null when its body has none. */
  | { kind: "conflict"; error: string | null }
  /** Any other 4xx: the server refused the delete, and trying again won't help; `error` as for a 409. */
  | { kind: "refused"; error: string | null }
  | Refused;

/**
 * Deletes the Product `id` (DELETE /api/products/:id). The server checks the Role and runs the Product's Patch Scan
 * with no dependencies before it answers, so its CVE Findings turn Fixed. A 5xx, or any other answer `DeleteResult`
 * doesn't name outside the 4xx, is not answering: a delete is safe to try again, as a repeat of one that landed gets
 * the 404.
 */
export async function deleteProduct(getToken: GetToken, id: string): Promise<DeleteResult> {
  const res = await callWarden(getToken, `/api/products/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!(res instanceof Response)) return res;
  switch (res.status) {
    case 204:
      return { kind: "deleted" };
    case 403:
      return { kind: "forbidden" };
    case 404:
      return { kind: "not-found" };
    case 409:
      return { kind: "conflict", error: await serverError(res) };
  }
  if (res.status >= 400 && res.status < 500)
    return { kind: "refused", error: await serverError(res) };
  return { kind: "not-answering" };
}

/**
 * Deletes as `deleteProduct` does, but only once /api/me says the session is in `team`, the Team the confirm was
 * opened in, and with the token that answer was asked with (`confirmTeam`); while it names another Team, or gives no
 * answer, nothing is sent.
 */
export async function deleteProductInTeam(
  getToken: GetToken,
  team: string | null,
  id: string,
): Promise<DeleteResult | TeamCheckRefused> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  return deleteProduct(inTeam.getToken, id);
}

/** How a Product uses a framework, in words. */
export const USAGE_WORDS: Record<Usage, string> = {
  self_hosted: "Self-hosted",
  library: "Library",
  transitive: "Through another package",
  hosted: "Hosted",
};
