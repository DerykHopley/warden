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
   * The change may have been saved: the server gave no answer (`reason` "not-answering"), or a 2xx whose body isn't a
   * Product ("unreadable").
   */
  | { kind: "maybe-saved"; reason: "not-answering" | "unreadable" }
  | Exclude<Refused, { kind: "not-answering" }>;

/**
 * Whether a save a Team or Role change dropped still reads the list again, back on its Team: the server answered, and
 * its answer may mean a Product was stored ("saved", or "maybe-saved" for an unreadable body). A save that got no
 * answer leaves the list as it is: the server may still be down, and a read would swap the list for the server-down
 * notice, an alert about a save no longer shown. A save still shown reads again on either "maybe-saved": the Products
 * page's `switch` on its answer reads the list again in its "saved" and "maybe-saved" cases.
 */
export function rereadsAfterDrop(result: SaveResult | TeamCheckRefused): boolean {
  return (
    result.kind === "saved" || (result.kind === "maybe-saved" && result.reason === "unreadable")
  );
}

/**
 * Whether a delete a Team or Role change dropped still reads the list again, back on its Team: the server answered that
 * the Product isn't stored ("deleted", or "not-found" when it was already gone). No answer leaves the list as it is, as
 * for a save (`rereadsAfterDrop`).
 */
export function rereadsAfterDroppedDelete(result: DeleteResult | TeamCheckRefused): boolean {
  return result.kind === "deleted" || result.kind === "not-found";
}

/** The Products pages shown now, each told when a dropped change may have changed a Team's Products. */
const productsWatchers = new Set<(team: string | null) => void>();

/**
 * Calls `watcher` with the Team whenever a dropped save or delete may have changed that Team's Products; it returns
 * the call that stops it. A Team switch mounts a fresh Products page, so the page that sent a change may be gone by
 * the time its answer arrives: the page shown then is the one that reads the list again.
 */
export function watchProducts(watcher: (team: string | null) => void): () => void {
  productsWatchers.add(watcher);
  return () => productsWatchers.delete(watcher);
}

/** Tells each Products page shown now that `team`'s Products may have changed. */
export function productsMayHaveChanged(team: string | null): void {
  for (const watcher of productsWatchers) watcher(team);
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
    return res.kind === "not-answering" ? { kind: "maybe-saved", reason: "not-answering" } : res;
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
    ? { kind: "maybe-saved", reason: "unreadable" }
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

/** The id of a Product's entry on the Products page, which a link names to open the page on it (#210). */
export const productAnchor = (id: string) => `product-${id}`;

/** Where a Product Asset's name links: the Products page, opened on that Product's entry. */
export const productHref = (id: string) => `/products#${productAnchor(id)}`;

/** How a Product uses a framework, in words. */
export const USAGE_WORDS: Record<Usage, string> = {
  self_hosted: "Self-hosted",
  library: "Library",
  transitive: "Through another package",
  hosted: "Hosted",
};
