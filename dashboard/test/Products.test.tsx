// The Products page (stories 1 and 2, read half): the Team's Products with their Repo URLs and dependencies, the same
// for every Role, with nothing to change them; and each answer the page's calls can get.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAMEWORKS_WAIT_MS, ProductsPage } from "../src/Products.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";

const CHAT = {
  id: "prod_chat",
  name: "Chat assistant",
  repo_urls: ["https://github.com/acme/chat", "https://github.com/acme/chat-infra"],
  dependencies: [
    { framework: "langflow", version: "1.4.0", usage: "self_hosted", internet_facing: true },
    { framework: "litellm", version: null, usage: "transitive", internet_facing: false },
  ],
};
const SEARCH = {
  id: "prod_search",
  name: "Search",
  repo_urls: [],
  dependencies: [
    { framework: "llamaindex", version: "0.12.1", usage: "library", internet_facing: false },
    { framework: "ollama", version: "0.6.0", usage: "hosted", internet_facing: true },
  ],
};

const FRAMEWORKS = [
  { id: "langflow", name: "Langflow", purls: ["pkg:pypi/langflow"], coverage: "package" },
  { id: "litellm", name: "LiteLLM", purls: ["pkg:pypi/litellm"], coverage: "package" },
  { id: "llamaindex", name: "LlamaIndex", purls: ["pkg:pypi/llama-index"], coverage: "package" },
  {
    id: "ollama",
    name: "Ollama",
    purls: ["pkg:golang/github.com/ollama/ollama"],
    coverage: "package",
  },
];

const productsAnswer = (products: unknown[], team = "org_a") => json(200, { team, products });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders ProductsPage alone as `role`, with both calls answered unless `routes` says otherwise. */
function renderProducts(role: Role, routes: Routes = {}) {
  serve({
    products: () => productsAnswer([CHAT, SEARCH]),
    frameworks: () => json(200, { frameworks: FRAMEWORKS }),
    ...routes,
  });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
  render(<ProductsPage {...props} />);
  return props;
}

/** One Product's entry in the list, found by its name. */
const product = (name: string) => {
  const entry = screen.getByRole("heading", { level: 2, name }).closest("li");
  if (entry === null) throw new Error(`${name} isn't in a list entry`);
  return within(entry);
};

/** Each dependency row of a Product, as its text. */
const dependencyRows = (name: string) =>
  within(product(name).getByRole("list", { name: "Dependencies" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

const failsWith = (status: number, error: string) => () => json(status, { error });

describe("ProductsPage", () => {
  it.each<Role>(["member", "admin"])(
    "shows a %s each Product with its Repo URLs and dependencies, and nothing to change them",
    async (role) => {
      renderProducts(role);
      expect(
        await screen.findByRole("heading", { level: 2, name: "Chat assistant" }),
      ).toBeInTheDocument();

      expect(screen.getByRole("heading", { level: 1, name: "Products" })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
        "Chat assistant",
        "Search",
      ]);
      expect(
        product("Chat assistant")
          .getAllByRole("link")
          .map((link) => link.getAttribute("href")),
      ).toEqual(["https://github.com/acme/chat", "https://github.com/acme/chat-infra"]);
      expect(dependencyRows("Chat assistant")).toEqual([
        "Langflow 1.4.0 Self-hosted internet-facing",
        "LiteLLM version unknown Through another package",
      ]);
      expect(dependencyRows("Search")).toEqual([
        "LlamaIndex 0.12.1 Library",
        "Ollama 0.6.0 Hosted internet-facing",
      ]);
      expect(product("Search").queryAllByRole("link")).toEqual([]);
      expect(screen.queryAllByRole("button")).toEqual([]);
      expect(screen.queryAllByRole("textbox")).toEqual([]);
      expect(screen.queryAllByRole("combobox")).toEqual([]);
      expect(screen.queryAllByRole("checkbox")).toEqual([]);
    },
  );

  it("shows a name and a Repo URL holding markup as text, and opens each Repo URL in a new tab without an opener", async () => {
    const markup = {
      ...CHAT,
      name: "<script>alert('name')</script>",
      repo_urls: ["https://example.com/<script>alert('url')</script>"],
    };
    renderProducts("member", { products: () => productsAnswer([markup]) });

    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "<script>alert('name')</script>",
    });
    expect(heading.querySelector("script")).toBeNull();
    const link = screen.getByRole("link", {
      name: "https://example.com/<script>alert('url')</script>",
    });
    expect(link.querySelector("script")).toBeNull();
    expect(link).toHaveAttribute("href", "https://example.com/<script>alert('url')</script>");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.body.querySelectorAll("script")).toHaveLength(0);
  });

  it("with the frameworks not loaded, still shows the list, with each framework's id in place of its name", async () => {
    renderProducts("member", { frameworks: failsWith(500, "Something went wrong") });
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

    expect(dependencyRows("Chat assistant")).toEqual([
      "langflow 1.4.0 Self-hosted internet-facing",
      "litellm version unknown Through another package",
    ]);
    expect(screen.queryByText(/isn't answering/)).not.toBeInTheDocument();
  });

  it("shows a framework id the frameworks list doesn't have as its id", async () => {
    renderProducts("member", {
      frameworks: () => json(200, { frameworks: FRAMEWORKS.filter((f) => f.id !== "litellm") }),
    });
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

    expect(dependencyRows("Chat assistant")).toEqual([
      "Langflow 1.4.0 Self-hosted internet-facing",
      "litellm version unknown Through another package",
    ]);
  });

  it("with the frameworks not answering, shows the list with ids once it has waited FRAMEWORKS_WAIT_MS", async () => {
    // Only the timeouts are fake, and only until the wait is over: Testing Library's findBy needs a real setTimeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderProducts("member", { frameworks: () => new Promise<Response>(() => {}) });

    await act(() => vi.advanceTimersByTimeAsync(FRAMEWORKS_WAIT_MS - 1));
    expect(screen.getByText("Loading Products…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    expect(dependencyRows("Chat assistant")).toEqual([
      "langflow 1.4.0 Self-hosted internet-facing",
      "litellm version unknown Through another package",
    ]);
  });

  it("shows a refusal of the list at once, without waiting for the frameworks", async () => {
    renderProducts("member", {
      products: failsWith(409, "Your Team's Admin must open Warden first"),
      frameworks: () => new Promise<Response>(() => {}),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your Team's Admin must open Warden first. Try again once they have.",
    );
    expect(screen.queryByText("Loading Products…")).not.toBeInTheDocument();
  });

  it("ends the session when the frameworks call finds it ended", async () => {
    const props = renderProducts("member", {
      frameworks: () => json(401, { error: "Not signed in" }),
    });
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("says it's loading until both calls have answered", async () => {
    const frameworks = deferred<Response>();
    renderProducts("member", { frameworks: () => frameworks.promise });

    expect(screen.getByText("Loading Products…")).toBeInTheDocument();
    await vi.waitFor(() => expect(callsTo("/api/products")).toHaveLength(1));
    expect(screen.getByText("Loading Products…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();

    frameworks.resolve(json(200, { frameworks: FRAMEWORKS }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading Products…")).not.toBeInTheDocument();
  });

  it("when the list gets no answer, says so, and Retry shows loading and reads again", async () => {
    const second = deferred<Response>();
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => second.promise,
    ];
    renderProducts("member", { products: () => answers.shift()!() });

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Loading Products…")).toBeInTheDocument();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();

    second.resolve(productsAnswer([CHAT]));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" }),
    ).toBeInTheDocument();
    expect(callsTo("/api/products")).toHaveLength(2);
  });

  it("on too many sign-in attempts, says how long to wait", async () => {
    renderProducts("member", {
      products: () => json(429, { error: "Too many attempts" }, { "Retry-After": "30" }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Try again in 30 seconds.",
    );
  });

  it("on a 403, says to choose a Team", async () => {
    renderProducts("member", { products: failsWith(403, "Choose a Team first") });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a Team first, from the switcher above.",
    );
    expect(screen.queryByText(/isn't answering/)).not.toBeInTheDocument();
  });

  it("on a 409, says the Team's Admin must open Warden first", async () => {
    renderProducts("member", {
      products: failsWith(409, "Your Team's Admin must open Warden first"),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your Team's Admin must open Warden first. Try again once they have.",
    );
    expect(screen.queryByText(/isn't answering/)).not.toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    const props = renderProducts("member", {
      products: () => json(401, { error: "Not signed in" }),
    });
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
  });

  it("with no Products, tells a Member a Lead or an Admin adds them", async () => {
    renderProducts("member", { products: () => productsAnswer([]) });
    expect(await screen.findByText("No Products yet.")).toBeInTheDocument();
    expect(screen.getByText("A Lead or an Admin adds them.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each<Role>(["lead", "admin"])(
    "with no Products, tells a %s only that there are none",
    async (role) => {
      renderProducts(role, { products: () => productsAnswer([]) });
      expect(await screen.findByText("No Products yet.")).toBeInTheDocument();
      expect(screen.queryByText("A Lead or an Admin adds them.")).not.toBeInTheDocument();
    },
  );

  it("asks again when the answer is about another Team, and never shows it", async () => {
    const answers = [productsAnswer([{ ...SEARCH, name: "Bluebird's secret" }], "org_b")];
    renderProducts("member", { products: () => answers.shift() ?? productsAnswer([CHAT]) });

    expect(
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(callsTo("/api/products")).toHaveLength(2);
    expect(screen.queryByText("Bluebird's secret")).not.toBeInTheDocument();
  });
});
