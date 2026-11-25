// The Products page's calls: GET /api/products, GET /api/patch/frameworks, a Product's save (POST or PUT) and its
// delete, each answer read into what the page shows; and the save limit's words.
import type { ProductInput } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAgainIn } from "../src/api.ts";
import {
  confirmTeam,
  deleteProduct,
  deleteProductInTeam,
  fetchFrameworks,
  fetchProducts,
  saveProduct,
  saveProductInTeam,
} from "../src/products.ts";
import { callsTo, fetchMock, json, noContent, serve } from "./fake-api.ts";

const getToken = async () => "session-token" as string | null;

const product = {
  id: "prod_1",
  name: "Chat assistant",
  repo_urls: ["https://github.com/acme/chat"],
  dependencies: [
    { framework: "langflow", version: "1.4.0", usage: "self_hosted", internet_facing: true },
  ],
};

const answers = (res: Response) => fetchMock.mockResolvedValue(res);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchProducts", () => {
  it("reads a 200 into the Team and its Products, asking with the session token", async () => {
    answers(json(200, { team: "org_a", products: [product] }));

    expect(await fetchProducts(getToken)).toEqual({
      kind: "products",
      team: "org_a",
      products: [product],
    });
    expect(callsTo("/api/products")[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("reads a 403 as no Team", async () => {
    answers(json(403, { error: "Choose a Team first" }));
    expect(await fetchProducts(getToken)).toEqual({ kind: "no-team" });
  });

  it("reads a 409 as the Team not opened", async () => {
    answers(json(409, { error: "Your Team's Admin must open Warden first" }));
    expect(await fetchProducts(getToken)).toEqual({ kind: "team-not-opened" });
  });

  it("reads a 401 as the session ended", async () => {
    answers(json(401, { error: "Not signed in" }));
    expect(await fetchProducts(getToken)).toEqual({ kind: "session-ended" });
  });

  it("reads a 200 whose body isn't a ProductsBody as not answering", async () => {
    answers(
      json(200, { team: "org_a", products: [{ ...product, usage: "everywhere" }], extra: 1 }),
    );
    expect(await fetchProducts(getToken)).toEqual({ kind: "not-answering" });
  });
});

describe("fetchFrameworks", () => {
  const langflow = {
    id: "langflow",
    name: "Langflow",
    purls: ["pkg:pypi/langflow"],
    coverage: "package",
  };

  it("reads a 200 into the frameworks", async () => {
    answers(json(200, { frameworks: [langflow] }));
    expect(await fetchFrameworks(getToken)).toEqual({ kind: "frameworks", frameworks: [langflow] });
    expect(callsTo("/api/patch/frameworks")).toHaveLength(1);
  });

  it("reads any other answer as not answering", async () => {
    answers(json(500, { error: "Something went wrong" }));
    expect(await fetchFrameworks(getToken)).toEqual({ kind: "not-answering" });
  });
});

describe("saveProduct", () => {
  const input: ProductInput = {
    name: product.name,
    repo_urls: product.repo_urls,
    dependencies: [
      { framework: "langflow", version: "1.4.0", usage: "self_hosted", internet_facing: true },
    ],
  };

  it("POSTs a new Product to /api/products and reads its 201 as saved", async () => {
    answers(json(201, product));

    expect(await saveProduct(getToken, null, input)).toEqual({ kind: "saved", product });
    const [init] = callsTo("/api/products").map(([, init]) => init);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("PUTs a change to /api/products/:id, its id encoded, and reads its 200 as saved", async () => {
    answers(json(200, { ...product, id: "prod/1" }));

    expect(await saveProduct(getToken, "prod/1", input)).toEqual({
      kind: "saved",
      product: { ...product, id: "prod/1" },
    });
    const [init] = callsTo("/api/products/prod%2F1").map(([, init]) => init);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it.each([
    [
      400,
      { error: "dependencies.0.version: a version has no spaces in it, such as 1.4.0" },
      {
        kind: "invalid",
        error: "dependencies.0.version: a version has no spaces in it, such as 1.4.0",
      },
    ],
    [403, { error: "Your Role can't do this" }, { kind: "forbidden" }],
    [404, { error: "No such Product" }, { kind: "not-found" }],
    [
      409,
      { error: 'Another Product in this Team is already called "Chat assistant"' },
      {
        kind: "conflict",
        error: 'Another Product in this Team is already called "Chat assistant"',
      },
    ],
    [409, {}, { kind: "conflict", error: null }],
    [401, { error: "Not signed in" }, { kind: "session-ended" }],
  ])("reads a %i into its kind", async (status, body, result) => {
    answers(json(status, body));
    expect(await saveProduct(getToken, "prod_1", input)).toEqual(result);
  });

  it("reads a 429 into too many attempts, with Retry-After's seconds", async () => {
    answers(json(429, { error: "Too many Product saves" }, { "Retry-After": "30" }));
    expect(await saveProduct(getToken, null, input)).toEqual({
      kind: "too-many-attempts",
      retryAfter: 30,
    });
  });

  it("reads a 2xx whose body isn't a Product as maybe saved", async () => {
    answers(json(201, { ...product, usage: "everywhere" }));
    expect(await saveProduct(getToken, null, input)).toEqual({ kind: "maybe-saved" });
  });

  it("reads no answer as maybe saved", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await saveProduct(getToken, null, input)).toEqual({ kind: "maybe-saved" });
  });
});

describe("saveProductInTeam", () => {
  const input: ProductInput = {
    name: product.name,
    repo_urls: product.repo_urls,
    dependencies: [],
  };

  /** A getToken that hands out a new token on each call, as Clerk can after a Team switch: token-1, token-2, … */
  const freshTokens = () => {
    let calls = 0;
    return vi.fn(async () => `token-${++calls}` as string | null);
  };

  /** /api/me names `teamFor(token)` for the token it was asked with. */
  const meNames = (teamFor: (token: string) => string) =>
    serve({
      me: () =>
        json(200, { userId: "user_1", team: teamFor(meToken()), role: "lead", level: "quick" }),
      saveProduct: () => json(201, product),
    });
  const meToken = () => {
    const [, init] = callsTo("/api/me").at(-1) ?? [];
    return new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
  };
  const saveToken = () => {
    const [[, init] = []] = callsTo("/api/products");
    return new Headers(init?.headers).get("Authorization");
  };

  it("saves with the token whose /api/me answer named the form's Team, never a later one", async () => {
    const getTokens = freshTokens();
    meNames((token) => (token === "token-1" ? "org_a" : "org_b"));

    expect(await saveProductInTeam(getTokens, "org_a", null, input)).toEqual({
      kind: "saved",
      product,
    });
    expect(saveToken()).toBe("Bearer token-1");
    expect(getTokens).toHaveBeenCalledTimes(1);
  });

  it("saves with the second answer's token when the first /api/me names another Team", async () => {
    const getTokens = freshTokens();
    meNames((token) => (token === "token-1" ? "org_b" : "org_a"));

    expect(await saveProductInTeam(getTokens, "org_a", null, input)).toEqual({
      kind: "saved",
      product,
    });
    expect(callsTo("/api/me")).toHaveLength(2);
    expect(saveToken()).toBe("Bearer token-2");
    expect(getTokens).toHaveBeenCalledTimes(2);
  });
});

describe("deleteProduct", () => {
  it("DELETEs /api/products/:id, its id encoded, and reads its 204 as deleted", async () => {
    answers(noContent());

    expect(await deleteProduct(getToken, "prod/1")).toEqual({ kind: "deleted" });
    const [init] = callsTo("/api/products/prod%2F1").map(([, init]) => init);
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it.each([
    [403, { error: "Your Role can't do this" }, { kind: "forbidden" }],
    [404, { error: "No such Product" }, { kind: "not-found" }],
    [
      409,
      { error: "Your Team's Admin must open Warden first" },
      { kind: "conflict", error: "Your Team's Admin must open Warden first" },
    ],
    [409, {}, { kind: "conflict", error: null }],
    [401, { error: "Not signed in" }, { kind: "session-ended" }],
    [500, { error: "Something went wrong" }, { kind: "not-answering" }],
    [503, {}, { kind: "not-answering" }],
    [400, { error: "Bad id" }, { kind: "refused", error: "Bad id" }],
    [405, {}, { kind: "refused", error: null }],
    [410, { error: "Gone" }, { kind: "refused", error: "Gone" }],
  ])("reads a %i into its kind", async (status, body, result) => {
    answers(json(status, body));
    expect(await deleteProduct(getToken, "prod_1")).toEqual(result);
  });

  it("reads a 429 into too many attempts, with Retry-After's seconds", async () => {
    answers(json(429, { error: "Too many Product saves" }, { "Retry-After": "30" }));
    expect(await deleteProduct(getToken, "prod_1")).toEqual({
      kind: "too-many-attempts",
      retryAfter: 30,
    });
  });

  it("reads no answer as not answering", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await deleteProduct(getToken, "prod_1")).toEqual({ kind: "not-answering" });
  });
});

describe("deleteProductInTeam", () => {
  it("deletes with the token whose /api/me answer named the Team, never a later one", async () => {
    let calls = 0;
    const getTokens = vi.fn(async () => `token-${++calls}` as string | null);
    const meToken = () => {
      const [, init] = callsTo("/api/me").at(-1) ?? [];
      return new Headers(init?.headers).get("Authorization");
    };
    serve({
      me: () =>
        json(200, {
          userId: "user_1",
          team: meToken() === "Bearer token-2" ? "org_a" : "org_b",
          role: "lead",
          level: "quick",
        }),
      deleteProduct: () => noContent(),
    });

    expect(await deleteProductInTeam(getTokens, "org_a", "prod_1")).toEqual({ kind: "deleted" });
    expect(callsTo("/api/me")).toHaveLength(2);
    const [[, init] = []] = callsTo("/api/products/prod_1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-2");
    expect(getTokens).toHaveBeenCalledTimes(2);
  });
});

describe("confirmTeam", () => {
  it("tells /api/me's 429, a sign-in limit, apart from a change's, and asks no more", async () => {
    answers(json(429, { error: "Too many attempts" }, { "Retry-After": "30" }));

    expect(await confirmTeam(getToken, "org_a")).toEqual({
      kind: "too-many-sign-ins",
      retryAfter: 30,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("tryAgainIn", () => {
  it("names what was done too often, when told", () => {
    expect(tryAgainIn(30, "changes to Products")).toBe(
      "Too many changes to Products. Try again in 30 seconds.",
    );
    expect(tryAgainIn(null, "changes to Products")).toBe(
      "Too many changes to Products. Try again in a minute.",
    );
  });

  it("says sign-in attempts when not told", () => {
    expect(tryAgainIn(30)).toBe("Too many sign-in attempts. Try again in 30 seconds.");
  });
});
