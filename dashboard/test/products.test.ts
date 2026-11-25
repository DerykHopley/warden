// The Products page's calls: GET /api/products and GET /api/patch/frameworks, each answer read into what the page shows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFrameworks, fetchProducts } from "../src/products.ts";
import { callsTo, fetchMock, json } from "./fake-api.ts";

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
