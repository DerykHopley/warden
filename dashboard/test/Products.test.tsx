// The Products page (stories 1 and 2, read half): the Team's Products with their Repo URLs and dependencies, the same
// for every Role, with nothing to change them; and each answer the page's calls can get.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAMEWORKS_WAIT_MS, ProductsPage } from "../src/Products.tsx";
import { callsTo, deferred, fetchMock, json, noContent, serve, type Routes } from "./fake-api.ts";

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
const DOCS_BOT = { ...SEARCH, id: "prod_new", name: "Docs bot" };

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

/**
 * Renders ProductsPage alone as `role` in org_a, with its calls (and /api/me, which a save asks first) answered unless
 * `routes` says otherwise. `rerender` gives the page a new Team or Role, as App does after /api/me answers again.
 */
function renderProducts(role: Role, routes: Routes = {}) {
  serve({
    me: () => json(200, { userId: "user_1", team: "org_a", role, level: "quick" }),
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
  const page = render(<ProductsPage {...props} />);
  const rerender = (me: { team?: string; role?: Role }, getToken = props.getToken) =>
    page.rerender(<ProductsPage {...props} getToken={getToken} me={{ ...props.me, ...me }} />);
  return { ...props, rerender };
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

/** A change (a save or a delete) that answers `status` with `{ error }` (an empty body without one). */
const refusesWith =
  (status: number, error?: string, headers: Record<string, string> = {}) =>
  () =>
    json(status, error === undefined ? {} : { error }, headers);

describe("ProductsPage", () => {
  it.each<Role>(["member", "admin"])(
    "shows a %s each Product with its Repo URLs and dependencies",
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
    },
  );

  it("offers a Member nothing that changes a Product", async () => {
    renderProducts("member");
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
  });

  it.each<Role>(["lead", "admin"])("offers a %s Add, and Edit on each Product", async (role) => {
    renderProducts(role);
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

    expect(screen.getByRole("button", { name: "Add a Product" })).toBeEnabled();
    expect(product("Chat assistant").getByRole("button", { name: /^Edit/ })).toBeEnabled();
    expect(product("Search").getByRole("button", { name: /^Edit/ })).toBeEnabled();
  });

  it.each<[Role, string[]]>([
    ["lead", ["Delete Chat assistant", "Delete Search"]],
    ["admin", ["Delete Chat assistant", "Delete Search"]],
    ["member", []],
  ])(
    "offers a %s Delete on each Product only when the Role changes Products",
    async (role, deletes) => {
      renderProducts(role);
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

      const offered = screen.queryAllByRole("button", { name: /^Delete/ });
      expect(offered.map((button) => button.getAttribute("aria-label"))).toEqual(deletes);
      for (const button of offered) expect(button).toBeEnabled();
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
      expect(screen.getByRole("button", { name: "Add a Product" })).toBeEnabled();
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

// Story 1: a Lead or an Admin adds and changes Products in a form on the page. The server checks the Role and each
// field; the form shows its refusals in its own line, keeping everything typed.
describe("ProductsPage's Product form", () => {
  /** The open form. */
  const form = () => within(screen.getByRole("form"));

  /** The list's GETs, apart from the saves' POSTs to the same path. */
  const listReads = () => callsTo("/api/products").filter(([, init]) => init?.method === "GET");

  /** Renders the page as an Admin and opens Add's form once the list shows. */
  async function openAdd(routes: Routes = {}) {
    const props = renderProducts("admin", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Add a Product" }));
    return props;
  }

  /** Renders the page as an Admin and opens Edit's form on Chat assistant. */
  async function openEdit(routes: Routes = {}) {
    const props = renderProducts("admin", routes);
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    await userEvent.click(product("Chat assistant").getByRole("button", { name: /^Edit/ }));
    return props;
  }

  const optionsOf = (select: HTMLElement) =>
    within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("lists the frameworks by name in the API's order, never offering one picked in another row", async () => {
    await openAdd();
    const addFramework = () => form().getByRole("button", { name: "Add a framework" });

    await userEvent.click(addFramework());
    const first = form().getByRole("combobox", { name: "Framework, Langflow" });
    expect(optionsOf(first)).toEqual(["Langflow", "LiteLLM", "LlamaIndex", "Ollama"]);

    await userEvent.click(addFramework());
    const second = form().getByRole("combobox", { name: "Framework, LiteLLM" });
    expect(optionsOf(first)).toEqual(["Langflow", "LlamaIndex", "Ollama"]);
    expect(optionsOf(second)).toEqual(["LiteLLM", "LlamaIndex", "Ollama"]);

    await userEvent.selectOptions(second, "Ollama");
    expect(optionsOf(first)).toEqual(["Langflow", "LiteLLM", "LlamaIndex"]);
    expect(form().getByRole("combobox", { name: "Framework, Ollama" })).toBe(second);

    await userEvent.click(addFramework());
    expect(form().getByRole("combobox", { name: "Framework, LiteLLM" })).toHaveValue("litellm");
    await userEvent.click(addFramework());
    expect(form().getByRole("combobox", { name: "Framework, LlamaIndex" })).toBeInTheDocument();
    expect(form().queryByRole("button", { name: "Add a framework" })).not.toBeInTheDocument();
  });

  it("starts a new framework row on Library, not internet-facing, with a blank version", async () => {
    await openAdd();
    await userEvent.click(form().getByRole("button", { name: "Add a framework" }));

    expect(form().getByRole("textbox", { name: "Version, Langflow" })).toHaveValue("");
    const usage = form().getByRole("combobox", { name: "Usage, Langflow" });
    expect(usage).toHaveValue("library");
    expect(optionsOf(usage)).toEqual([
      "Self-hosted",
      "Library",
      "Through another package",
      "Hosted",
    ]);
    expect(form().getByRole("checkbox", { name: "Internet-facing, Langflow" })).not.toBeChecked();
  });

  it("hides Add a Repo URL once there are 20", async () => {
    await openAdd();
    const addRepo = () => form().getByRole("button", { name: "Add a Repo URL" });
    for (let i = 0; i < 19; i++) await userEvent.click(addRepo());
    expect(form().getAllByRole("textbox", { name: /^Repo URL/ })).toHaveLength(19);
    await userEvent.click(addRepo());
    expect(form().getAllByRole("textbox", { name: /^Repo URL/ })).toHaveLength(20);
    expect(form().queryByRole("button", { name: "Add a Repo URL" })).not.toBeInTheDocument();
  });

  it("Add POSTs the Product, a blank version as null and a blank Repo URL row left out; a blank name keeps Save disabled", async () => {
    const sent: unknown[] = [];
    await openAdd({
      saveProduct: (id, body) => {
        sent.push({ id, body });
        return json(201, DOCS_BOT);
      },
    });
    const save = form().getByRole("button", { name: "Save" });
    const name = form().getByRole("textbox", { name: "Name" });
    expect(save).toBeDisabled();
    await userEvent.type(name, "   ");
    expect(save).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, "Docs bot");
    expect(save).toBeEnabled();

    await userEvent.click(form().getByRole("button", { name: "Add a Repo URL" }));
    await userEvent.click(form().getByRole("button", { name: "Add a Repo URL" }));
    await userEvent.type(
      form().getByRole("textbox", { name: "Repo URL 2" }),
      "https://github.com/acme/docs",
    );
    await userEvent.click(form().getByRole("button", { name: "Add a framework" }));
    await userEvent.click(form().getByRole("button", { name: "Add a framework" }));
    await userEvent.type(form().getByRole("textbox", { name: "Version, LiteLLM" }), "1.2.3");
    await userEvent.selectOptions(
      form().getByRole("combobox", { name: "Usage, LiteLLM" }),
      "Hosted",
    );
    await userEvent.click(form().getByRole("checkbox", { name: "Internet-facing, LiteLLM" }));
    await userEvent.click(save);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      id: null,
      body: {
        name: "Docs bot",
        repo_urls: ["https://github.com/acme/docs"],
        dependencies: [
          { framework: "langflow", version: null, usage: "library", internet_facing: false },
          { framework: "litellm", version: "1.2.3", usage: "hosted", internet_facing: true },
        ],
      },
    });
  });

  it("Edit opens the form filled with the Product, and Save PUTs the whole Product as changed", async () => {
    const sent: unknown[] = [];
    await openEdit({
      saveProduct: (id, body) => {
        sent.push({ id, body });
        return json(200, CHAT);
      },
    });

    expect(screen.getByRole("form", { name: "Edit Chat assistant" })).toBeInTheDocument();
    expect(form().getByRole("textbox", { name: "Name" })).toHaveValue("Chat assistant");
    expect(form().getByRole("textbox", { name: "Repo URL 1" })).toHaveValue(
      "https://github.com/acme/chat",
    );
    expect(form().getByRole("textbox", { name: "Repo URL 2" })).toHaveValue(
      "https://github.com/acme/chat-infra",
    );
    expect(form().getByRole("combobox", { name: "Framework, Langflow" })).toHaveValue("langflow");
    expect(form().getByRole("textbox", { name: "Version, Langflow" })).toHaveValue("1.4.0");
    expect(form().getByRole("combobox", { name: "Usage, Langflow" })).toHaveValue("self_hosted");
    expect(form().getByRole("checkbox", { name: "Internet-facing, Langflow" })).toBeChecked();
    expect(form().getByRole("textbox", { name: "Version, LiteLLM" })).toHaveValue("");
    expect(form().getByRole("combobox", { name: "Usage, LiteLLM" })).toHaveValue("transitive");
    expect(form().getByRole("checkbox", { name: "Internet-facing, LiteLLM" })).not.toBeChecked();

    // A rename, a new version, a Repo URL and a framework removed: the PUT carries the whole Product as it now is.
    const name = form().getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Chat helper");
    const version = form().getByRole("textbox", { name: "Version, Langflow" });
    await userEvent.clear(version);
    await userEvent.type(version, "1.5.0");
    await userEvent.click(form().getByRole("button", { name: "Remove Repo URL 1" }));
    await userEvent.click(form().getByRole("button", { name: "Remove LiteLLM" }));
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      id: "prod_chat",
      body: {
        name: "Chat helper",
        repo_urls: ["https://github.com/acme/chat-infra"],
        dependencies: [
          { framework: "langflow", version: "1.5.0", usage: "self_hosted", internet_facing: true },
        ],
      },
    });
  });

  it.each([
    [
      "a 400 shows the server's words",
      refusesWith(400, "dependencies.0.version: a version has no spaces in it, such as 1.4.0"),
      "dependencies.0.version: a version has no spaces in it, such as 1.4.0",
    ],
    [
      "a 409 shows the server's words",
      refusesWith(409, 'Another Product in this Team is already called "Search"'),
      'Another Product in this Team is already called "Search"',
    ],
    ["a 409 with no words says Warden refused it", refusesWith(409), "Warden refused this change."],
    // tryAgainIn's own tests hold its wording; this only shows the save limit's refusal reaches the form.
    [
      "a 429 says too many changes",
      refusesWith(429, "Too many Product saves", { "Retry-After": "30" }),
      "Too many changes to Products",
    ],
  ])("%s in the form, keeping everything typed", async (_case, answer, words) => {
    await openEdit({ saveProduct: answer });
    const name = form().getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Search");
    await userEvent.type(form().getByRole("textbox", { name: "Version, LiteLLM" }), "1 2");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    expect(await form().findByRole("alert")).toHaveTextContent(words);
    expect(form().getByRole("alert")).not.toHaveTextContent(/sign-in/);
    expect(form().getByRole("textbox", { name: "Name" })).toHaveValue("Search");
    expect(form().getByRole("textbox", { name: "Version, LiteLLM" })).toHaveValue("1 2");
    expect(form().getByRole("textbox", { name: "Repo URL 2" })).toHaveValue(
      "https://github.com/acme/chat-infra",
    );
    expect(form().getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 201 whose body isn't a Product", () => json(201, { ...CHAT, usage: "everywhere" })],
  ])(
    "on %s, says the change may have been saved, reads the list again, and keeps what was typed",
    async (_case, answer) => {
      await openEdit({ saveProduct: answer });
      await userEvent.type(form().getByRole("textbox", { name: "Name" }), " 2");
      await userEvent.click(form().getByRole("button", { name: "Save" }));

      expect(await form().findByRole("alert")).toHaveTextContent(
        "Warden's server didn't answer, so the change may have been saved. Check the list before you try again.",
      );
      await vi.waitFor(() => expect(listReads()).toHaveLength(2));
      expect(form().getByRole("textbox", { name: "Name" })).toHaveValue("Chat assistant 2");
    },
  );

  it("a 400 about a Repo URL names the row on screen, counting the blank rows the save left out", async () => {
    await openAdd({
      saveProduct: refusesWith(400, "repo_urls.1: Invalid URL; name: Too long"),
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    for (let i = 0; i < 3; i++) {
      await userEvent.click(form().getByRole("button", { name: "Add a Repo URL" }));
    }
    // Row 1 is blank, so the server's repo_urls.1 is the third row on screen.
    await userEvent.type(form().getByRole("textbox", { name: "Repo URL 2" }), "https://a.example");
    await userEvent.type(form().getByRole("textbox", { name: "Repo URL 3" }), "not a url");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    expect(await form().findByRole("alert")).toHaveTextContent(
      "Repo URL 3: Invalid URL; name: Too long",
    );
  });

  it("checks the session is still in the form's Team before it saves, and sends nothing while it names another", async () => {
    const saveProduct = vi.fn(() => json(201, CHAT));
    await openAdd({
      me: () => json(200, { userId: "user_1", team: "org_b", role: "admin", level: "quick" }),
      saveProduct,
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    expect(await form().findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
      "Warden's server isn't answering. Try again.",
    );
    expect(callsTo("/api/me").length).toBeGreaterThan(1);
    expect(saveProduct).not.toHaveBeenCalled();
  });

  it("saves once /api/me names the form's Team", async () => {
    const order: string[] = [];
    const teams = ["org_b"];
    await openAdd({
      me: () => {
        const team = teams.shift() ?? "org_a";
        order.push(`me:${team}`);
        return json(200, { userId: "user_1", team, role: "admin", level: "quick" });
      },
      saveProduct: () => {
        order.push("save");
        return json(201, DOCS_BOT);
      },
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(order).toEqual(["me:org_b", "me:org_a", "save"]));
  });

  it("drops a save's answer that arrives after a Team switch, reading nothing", async () => {
    const answer = deferred<Response>();
    let team = "org_a";
    let posted = false;
    const bluebirdReads = [
      productsAnswer([{ ...SEARCH, id: "prod_b", name: "Bluebird" }], "org_b"),
    ];
    const props = await openAdd({
      products: () =>
        team === "org_a"
          ? productsAnswer([CHAT, SEARCH])
          : (bluebirdReads.shift() ?? new Promise<Response>(() => {})),
      saveProduct: () => {
        posted = true;
        return answer.promise;
      },
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(posted).toBe(true));

    team = "org_b";
    props.rerender({ team });
    await screen.findByRole("heading", { level: 2, name: "Bluebird" });
    const reads = listReads().length;
    await act(async () => {
      answer.resolve(json(201, DOCS_BOT));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(listReads()).toHaveLength(reads);
    expect(screen.queryByRole("heading", { level: 2, name: "Docs bot" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Bluebird",
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a Team switch forgets a save under way: the new Team's form saves at once, and the old answer leaves it busy", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let team = "org_a";
    const bluebird = { ...SEARCH, id: "prod_b", name: "Bluebird" };
    const saveProduct = vi.fn(() => (saveProduct.mock.calls.length === 1 ? first : second).promise);
    const props = await openAdd({
      me: () => json(200, { userId: "user_1", team, role: "admin", level: "quick" }),
      products: () =>
        team === "org_a" ? productsAnswer([CHAT, SEARCH]) : productsAnswer([bluebird], "org_b"),
      saveProduct,
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(saveProduct).toHaveBeenCalledTimes(1));

    team = "org_b";
    props.rerender({ team });
    await screen.findByRole("heading", { level: 2, name: "Bluebird" });
    await userEvent.click(screen.getByRole("button", { name: "Add a Product" }));
    const name = form().getByRole("textbox", { name: "Name" });
    expect(name).toBeEnabled();
    await userEvent.type(name, "Kite");
    const save = form().getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-busy");
    await userEvent.click(save);
    await vi.waitFor(() => expect(saveProduct).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve(json(201, DOCS_BOT));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(form().getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("heading", { level: 2, name: "Docs bot" })).not.toBeInTheDocument();
  });

  /**
   * Saves "Docs bot" as an Admin with its answer held, goes `away` and `back`, and opens Add again once the list
   * shows. `products` answers the list's reads.
   */
  async function saveThenAwayAndBack(
    away: { team?: string; role?: Role },
    back: { team?: string; role?: Role },
    products?: () => Response | Promise<Response>,
  ) {
    const answer = deferred<Response>();
    const saveProduct = vi.fn(() => answer.promise);
    const props = await openAdd(
      products === undefined ? { saveProduct } : { saveProduct, products },
    );
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(saveProduct).toHaveBeenCalled());

    props.rerender(away);
    props.rerender(back);
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    await userEvent.click(screen.getByRole("button", { name: "Add a Product" }));
    return { ...props, answer };
  }

  it("drops a save's answer that arrives after a Role lowered to Member and back (a 401), the form opened since left as it is", async () => {
    const { answer, onSessionEnded } = await saveThenAwayAndBack(
      { role: "member" },
      { role: "admin" },
    );
    const reads = listReads().length;
    await act(async () => {
      answer.resolve(json(401, {}));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(listReads()).toHaveLength(reads);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(form().getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it.each([
    ["a Team switch", "a 201", { team: "org_b" }, { team: "org_a" }, DOCS_BOT],
    [
      "a Role lowered to Member",
      "a 201",
      { role: "member" as Role },
      { role: "admin" as Role },
      DOCS_BOT,
    ],
    ["a Team switch", "a 201 with no Product", { team: "org_b" }, { team: "org_a" }, {}],
  ])(
    "a save's answer that arrives after %s and back (%s) reads the list again, so it shows what the server stored; the form opened since left as it is",
    async (_case, _answer, away, back, body) => {
      let stored = [CHAT, SEARCH];
      const { answer, onSessionEnded } = await saveThenAwayAndBack(away, back, () =>
        productsAnswer(stored),
      );
      const reads = listReads().length;
      stored = [CHAT, SEARCH, DOCS_BOT];
      await act(async () => {
        answer.resolve(json(201, body));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(
        await screen.findByRole("heading", { level: 2, name: "Docs bot" }),
      ).toBeInTheDocument();
      expect(listReads()).toHaveLength(reads + 1);
      expect(onSessionEnded).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(form().getByRole("textbox", { name: "Name" })).toHaveFocus();
    },
  );

  it.each([
    ["a Team switch", { team: "org_b" }, { team: "org_a" }],
    ["a Role lowered to Member", { role: "member" as Role }, { role: "admin" as Role }],
  ])(
    "closes the form on %s, and doesn't open it again on the way back",
    async (_case, away, back) => {
      const props = await openAdd();
      await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");

      props.rerender(away);
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      props.rerender(back);
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    },
  );

  it("a 403 says only a Lead or an Admin can change Products, and asks /api/me again", async () => {
    const props = await openEdit({ saveProduct: refusesWith(403, "Your Role can't do this") });
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    expect(await form().findByRole("alert")).toHaveTextContent(
      "Only a Lead or an Admin can change Products.",
    );
    expect(props.refreshMe).toHaveBeenCalled();
  });

  it("a 404 says the Product is no longer in the Team, reads the list again, and keeps the form open", async () => {
    await openEdit({ saveProduct: refusesWith(404, "No such Product") });
    expect(listReads()).toHaveLength(1);
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), " 2");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    expect(await form().findByRole("alert")).toHaveTextContent(
      "This Product is no longer in your Team.",
    );
    await vi.waitFor(() => expect(listReads()).toHaveLength(2));
    expect(form().getByRole("textbox", { name: "Name" })).toHaveValue("Chat assistant 2");
  });

  it("a 404 keeps the form open once the list no longer has the Product", async () => {
    const lists = [productsAnswer([CHAT, SEARCH])];
    await openEdit({
      products: () => lists.shift() ?? productsAnswer([SEARCH]),
      saveProduct: refusesWith(404, "No such Product"),
    });
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "Chat assistant" })).toBeNull(),
    );
    expect(form().getByRole("alert")).toHaveTextContent("This Product is no longer in your Team.");
    expect(form().getByRole("textbox", { name: "Name" })).toHaveValue("Chat assistant");
    // Its name is the Product's as Edit opened it, though the list no longer has it.
    expect(screen.getByRole("form", { name: "Edit Chat assistant" })).toBeInTheDocument();
  });

  it("a 401 ends the session", async () => {
    const props = await openEdit({ saveProduct: refusesWith(401, "Not signed in") });
    await userEvent.click(form().getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
  });

  it("Cancel closes the form and puts focus back on the button that opened it", async () => {
    await openAdd();
    await userEvent.click(form().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a Product" })).toHaveFocus();

    await userEvent.click(product("Search").getByRole("button", { name: /^Edit/ }));
    expect(screen.getByRole("form", { name: "Edit Search" })).toBeInTheDocument();
    await userEvent.click(form().getByRole("button", { name: "Cancel" }));
    expect(product("Search").getByRole("button", { name: /^Edit/ })).toHaveFocus();
  });

  describe("when a button disappears while it has focus", () => {
    /** Focuses `button` and presses Enter on it, as from the keyboard. */
    async function enterOn(button: HTMLElement) {
      act(() => button.focus());
      await userEvent.keyboard("{Enter}");
    }

    /** Esc closes the form and puts focus back on its opener: Edit on Chat assistant, or Add a Product. */
    async function escClosesTo(opener: "edit" | "add") {
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(
        opener === "edit"
          ? product("Chat assistant").getByRole("button", { name: /^Edit/ })
          : screen.getByRole("button", { name: "Add a Product" }),
      ).toHaveFocus();
    }

    /** Opens Edit's form on Chat assistant again, on the page already rendered. */
    const editAgain = () =>
      userEvent.click(product("Chat assistant").getByRole("button", { name: /^Edit/ }));
    const button = (name: string) => form().getByRole("button", { name });
    const repoUrl = (n: number) => form().getByRole("textbox", { name: `Repo URL ${n}` });

    it("Remove on a Repo URL row puts focus on the next row's field, else the one before, else Add a Repo URL", async () => {
      await openEdit();
      await enterOn(button("Remove Repo URL 2"));
      expect(repoUrl(1)).toHaveValue("https://github.com/acme/chat");
      expect(repoUrl(1)).toHaveFocus();
      await escClosesTo("edit");

      await editAgain();
      await enterOn(button("Remove Repo URL 1"));
      expect(repoUrl(1)).toHaveValue("https://github.com/acme/chat-infra");
      expect(repoUrl(1)).toHaveFocus();
      await escClosesTo("edit");

      await editAgain();
      await userEvent.click(button("Remove Repo URL 2"));
      await enterOn(button("Remove Repo URL 1"));
      expect(form().queryByRole("textbox", { name: /^Repo URL/ })).not.toBeInTheDocument();
      expect(button("Add a Repo URL")).toHaveFocus();
      await escClosesTo("edit");
    });

    it("Remove on a framework row puts focus on the next row's framework, else the one before, else Add a framework", async () => {
      const framework = (name: string) =>
        form().getByRole("combobox", { name: `Framework, ${name}` });

      await openEdit();
      await enterOn(button("Remove Langflow"));
      expect(framework("LiteLLM")).toHaveFocus();
      await escClosesTo("edit");

      await editAgain();
      await enterOn(button("Remove LiteLLM"));
      expect(framework("Langflow")).toHaveFocus();
      await escClosesTo("edit");

      await editAgain();
      await userEvent.click(button("Remove LiteLLM"));
      await enterOn(button("Remove Langflow"));
      expect(form().queryByRole("combobox", { name: /^Framework/ })).not.toBeInTheDocument();
      expect(button("Add a framework")).toHaveFocus();
      await escClosesTo("edit");
    });

    it("Add a framework adding the last framework puts focus on the new row's framework", async () => {
      await openAdd();
      for (let i = 0; i < 3; i++) await userEvent.click(button("Add a framework"));
      await enterOn(button("Add a framework"));
      expect(form().queryByRole("button", { name: "Add a framework" })).not.toBeInTheDocument();
      expect(form().getByRole("combobox", { name: "Framework, Ollama" })).toHaveFocus();
      await escClosesTo("add");
    });

    it("Add a Repo URL adding the 20th puts focus on Repo URL 20; below the limit, it keeps focus", async () => {
      await openAdd();
      await enterOn(button("Add a Repo URL"));
      expect(button("Add a Repo URL")).toHaveFocus();
      for (let i = 0; i < 18; i++) await userEvent.click(button("Add a Repo URL"));
      await enterOn(button("Add a Repo URL"));
      expect(form().queryByRole("button", { name: "Add a Repo URL" })).not.toBeInTheDocument();
      expect(repoUrl(20)).toHaveFocus();
      await escClosesTo("add");
    });
  });

  it("Enter in a Repo URL field saves nothing: twice on Remove Repo URL 2, or on the 20th Add a Repo URL; Enter in Name still saves", async () => {
    const saveProduct = vi.fn(() => json(200, CHAT));
    await openEdit({ saveProduct });
    act(() => form().getByRole("button", { name: "Remove Repo URL 2" }).focus());
    await userEvent.keyboard("{Enter}{Enter}");

    expect(form().queryByRole("textbox", { name: "Repo URL 2" })).not.toBeInTheDocument();
    expect(form().getByRole("textbox", { name: "Repo URL 1" })).toHaveFocus();
    expect(screen.getByRole("form", { name: "Edit Chat assistant" })).toBeInTheDocument();

    for (let i = 0; i < 18; i++) {
      await userEvent.click(form().getByRole("button", { name: "Add a Repo URL" }));
    }
    act(() => form().getByRole("button", { name: "Add a Repo URL" }).focus());
    await userEvent.keyboard("{Enter}{Enter}");
    expect(form().getByRole("textbox", { name: "Repo URL 20" })).toHaveFocus();
    expect(screen.getByRole("form")).toBeInTheDocument();
    expect(saveProduct).not.toHaveBeenCalled();

    act(() => form().getByRole("textbox", { name: "Name" }).focus());
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(saveProduct).toHaveBeenCalledTimes(1));
  });

  it("opens one form at a time, its name field focused", async () => {
    await openAdd();
    expect(form().getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(product("Chat assistant").getByRole("button", { name: /^Edit/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a Product" })).toBeDisabled();
  });

  it("after a save, reads the list again, closes the form and puts focus on the saved Product's name", async () => {
    const lists = [productsAnswer([CHAT, SEARCH])];
    await openAdd({
      products: () => lists.shift() ?? productsAnswer([CHAT, DOCS_BOT, SEARCH]),
      saveProduct: () => json(201, DOCS_BOT),
    });
    await userEvent.type(form().getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Docs bot" })).toHaveFocus(),
    );
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
        "Chat assistant",
        "Docs bot",
        "Search",
      ]),
    );
    expect(listReads()).toHaveLength(2);
  });

  it("after Edit's save, puts focus on the Product's new name", async () => {
    // The list read again after the save answers the Product as stored, as the server does.
    let stored = CHAT;
    await openEdit({
      products: () => productsAnswer([stored, SEARCH]),
      saveProduct: () => {
        stored = { ...CHAT, name: "Chat helper" };
        return json(200, stored);
      },
    });
    const name = form().getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Chat helper");
    await userEvent.click(form().getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Chat helper" })).toHaveFocus(),
    );
  });

  it("Save is busy and every control disabled while its call runs, and a second click sends nothing", async () => {
    const answer = deferred<Response>();
    const saveProduct = vi.fn(() => answer.promise);
    await openEdit({ saveProduct });
    const save = form().getByRole("button", { name: "Save" });
    await userEvent.click(save);

    await vi.waitFor(() => expect(saveProduct).toHaveBeenCalled());
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(form().getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(form().getByRole("combobox", { name: "Usage, Langflow" })).toBeDisabled();
    expect(form().getByRole("button", { name: "Remove Repo URL 1" })).toBeDisabled();
    await userEvent.click(save);
    // A submit that gets past the disabled button (Enter in a field, say) still sends nothing.
    act(() => screen.getByRole<HTMLFormElement>("form").requestSubmit());
    expect(saveProduct).toHaveBeenCalledTimes(1);

    answer.resolve(json(200, CHAT));
    await vi.waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    expect(saveProduct).toHaveBeenCalledTimes(1);
  });

  it("with the frameworks failing, disables Add and Edit and offers Retry, which enables them once the frameworks answer", async () => {
    const failing = [json(500, { error: "Something went wrong" })];
    renderProducts("admin", {
      frameworks: () => failing.shift() ?? json(200, { frameworks: FRAMEWORKS }),
    });
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });

    expect(screen.getByText("Couldn't load the frameworks.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a Product" })).toBeDisabled();
    expect(product("Chat assistant").getByRole("button", { name: /^Edit/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Add a Product" })).toBeEnabled(),
    );
    expect(product("Chat assistant").getByRole("button", { name: /^Edit/ })).toBeEnabled();
    expect(screen.queryByText("Couldn't load the frameworks.")).not.toBeInTheDocument();
    expect(dependencyRows("Chat assistant")[0]).toBe("Langflow 1.4.0 Self-hosted internet-facing");
  });
});

// Story 1: a Lead or an Admin deletes a Product after confirming. The server checks the Role; the confirm shows its
// refusals in its own line and stays open.
describe("ProductsPage's delete confirm", () => {
  const CONFIRM = "Delete Chat assistant? Its CVE Findings turn Fixed.";
  /** Chat assistant's open confirm. */
  const confirm = () => within(screen.getByRole("group", { name: CONFIRM }));
  const deleteOf = (name: string) => product(name).getByRole("button", { name: `Delete ${name}` });

  /** The DELETEs the fake API received, by path. */
  const deletes = () =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([input]) => String(input));
  const listReads = () => callsTo("/api/products").filter(([, init]) => init?.method === "GET");

  /** Renders the page as an Admin and opens Chat assistant's confirm once the list shows. */
  async function openConfirm(routes: Routes = {}) {
    const props = renderProducts("admin", routes);
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    await userEvent.click(deleteOf("Chat assistant"));
    return props;
  }

  /** Presses the confirm's Delete. */
  const confirmDelete = () => userEvent.click(confirm().getByRole("button", { name: "Delete" }));

  it("sends nothing until the confirm's Delete is pressed, then one DELETE of the Product", async () => {
    await openConfirm({ deleteProduct: noContent });
    expect(screen.getByRole("group", { name: CONFIRM })).toBeInTheDocument();
    expect(deletes()).toEqual([]);

    await confirmDelete();
    await vi.waitFor(() => expect(deletes()).toEqual(["/api/products/prod_chat"]));
  });

  it("opens with focus on Cancel; Cancel and Esc each close it and put focus back on the Product's Delete", async () => {
    await openConfirm();
    expect(confirm().getByRole("button", { name: "Cancel" })).toHaveFocus();

    await userEvent.click(confirm().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    expect(deleteOf("Chat assistant")).toHaveFocus();

    await userEvent.click(deleteOf("Chat assistant"));
    act(() => confirm().getByRole("button", { name: "Delete" }).focus());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    expect(deleteOf("Chat assistant")).toHaveFocus();
    expect(deletes()).toEqual([]);
  });

  it("after a delete, closes the confirm, reads the list again and puts focus on Add a Product", async () => {
    const lists = [productsAnswer([CHAT, SEARCH])];
    await openConfirm({
      products: () => lists.shift() ?? productsAnswer([SEARCH]),
      deleteProduct: noContent,
    });
    await confirmDelete();

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Add a Product" })).toHaveFocus(),
    );
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(listReads()).toHaveLength(2));
    expect(screen.queryByRole("heading", { level: 2, name: "Chat assistant" })).toBeNull();
  });

  it("while the delete runs, its Delete is busy, both buttons are disabled, Esc does nothing, and a second press sends nothing", async () => {
    const answer = deferred<Response>();
    await openConfirm({ deleteProduct: () => answer.promise });
    const remove = confirm().getByRole("button", { name: "Delete" });
    await userEvent.click(remove);

    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("aria-busy", "true");
    expect(confirm().getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.click(remove);
    act(() => {
      remove.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.getByRole("group", { name: CONFIRM })).toBeInTheDocument();
    expect(deletes()).toHaveLength(1);

    answer.resolve(noContent());
    await vi.waitFor(() =>
      expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument(),
    );
    expect(deletes()).toHaveLength(1);
  });

  it("while a form or a confirm is open, Add, every Edit and every Delete are disabled", async () => {
    const buttons = () => [
      screen.getByRole("button", { name: "Add a Product" }),
      ...screen.getAllByRole("button", { name: /^(Edit|Delete) / }),
    ];
    await openConfirm();
    expect(buttons()).toHaveLength(5);
    for (const button of buttons()) expect(button).toBeDisabled();

    await userEvent.click(confirm().getByRole("button", { name: "Cancel" }));
    await userEvent.click(product("Search").getByRole("button", { name: /^Edit/ }));
    // Search's entry is its form now: Add, Chat assistant's Edit and Delete wait.
    expect(buttons()).toHaveLength(3);
    for (const button of buttons()) expect(button).toBeDisabled();
  });

  it("a 403 says only a Lead or an Admin can change Products, and asks /api/me again", async () => {
    const props = await openConfirm({ deleteProduct: refusesWith(403, "Your Role can't do this") });
    await confirmDelete();

    expect(await confirm().findByRole("alert")).toHaveTextContent(
      "Only a Lead or an Admin can change Products.",
    );
    expect(props.refreshMe).toHaveBeenCalled();
  });

  it("a 404 closes the confirm, shows the gone notice above the list and reads the list again; opening a form removes it", async () => {
    const lists = [productsAnswer([CHAT, SEARCH])];
    await openConfirm({
      products: () => lists.shift() ?? productsAnswer([SEARCH]),
      deleteProduct: refusesWith(404, "No such Product"),
    });
    await confirmDelete();

    const notice = await screen.findByText("This Product is no longer in your Team.");
    expect(notice).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(listReads()).toHaveLength(2));
    // Above the list: before its first Product.
    const first = screen.getByRole("heading", { level: 2, name: "Search" });
    expect(notice.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a Product" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Add a Product" }));
    expect(screen.queryByText("This Product is no longer in your Team.")).not.toBeInTheDocument();
  });

  it.each([
    [
      "a 429 says too many changes to Products",
      refusesWith(429, "Too many Product saves", { "Retry-After": "30" }),
      "Too many changes to Products. Try again in 30 seconds.",
    ],
    [
      "a 409 shows the server's words",
      refusesWith(409, "Your Team's Admin must open Warden first"),
      "Your Team's Admin must open Warden first",
    ],
    ["a 409 with no words says Warden refused it", refusesWith(409), "Warden refused this change."],
    [
      "no answer says the server isn't answering",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Warden's server isn't answering. Try again.",
    ],
    ["another 4xx says Warden refused it", refusesWith(405), "Warden refused this change."],
  ])("%s in the confirm, which stays open", async (_case, answer, words) => {
    await openConfirm({ deleteProduct: answer });
    await confirmDelete();

    expect(await confirm().findByRole("alert")).toHaveTextContent(words);
    expect(confirm().getByRole("alert")).not.toHaveTextContent(/sign-in/);
    expect(confirm().getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("after a refusal, puts focus back on the confirm's Delete, so Esc still cancels it", async () => {
    const answer = deferred<Response>();
    await openConfirm({ deleteProduct: () => answer.promise });
    const remove = confirm().getByRole("button", { name: "Delete" });
    await userEvent.click(remove);
    await vi.waitFor(() => expect(remove).toBeDisabled());
    // A browser takes focus off a button that turns disabled; jsdom leaves it there, so the test does what a browser does.
    act(() => remove.blur());
    answer.resolve(refusesWith(409, "Your Team's Admin must open Warden first")());

    expect(await confirm().findByRole("alert")).toBeInTheDocument();
    expect(remove).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    expect(deleteOf("Chat assistant")).toHaveFocus();
  });

  it("a 429 from the Team check says too many sign-in attempts, never the Products change limit", async () => {
    const deleteProduct = vi.fn(noContent);
    await openConfirm({
      me: refusesWith(429, "Too many attempts", { "Retry-After": "30" }),
      deleteProduct,
    });
    await confirmDelete();

    expect(await confirm().findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Try again in 30 seconds.",
    );
    expect(deleteProduct).not.toHaveBeenCalled();
  });

  it("a 401 ends the session", async () => {
    const props = await openConfirm({ deleteProduct: refusesWith(401, "Not signed in") });
    await confirmDelete();
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
  });

  it("forgets the confirm, refusal and all, once a read of the list no longer has its Product", async () => {
    let listed = [CHAT, SEARCH];
    const props = await openConfirm({
      products: () => productsAnswer(listed),
      deleteProduct: refusesWith(409, "Your Team's Admin must open Warden first"),
    });
    await confirmDelete();
    await confirm().findByRole("alert");

    // A new getToken is a new read of the list.
    listed = [SEARCH];
    props.rerender(
      {},
      vi.fn(async () => "session-token-2" as string | null),
    );
    await screen.findByRole("heading", { level: 2, name: "Search" });
    expect(screen.queryByRole("heading", { level: 2, name: "Chat assistant" })).toBeNull();

    listed = [CHAT, SEARCH];
    props.rerender(
      {},
      vi.fn(async () => "session-token-3" as string | null),
    );
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
    expect(deleteOf("Chat assistant")).toBeEnabled();
  });

  it("sends no DELETE while /api/me names another Team, and says the server isn't answering", async () => {
    const deleteProduct = vi.fn(noContent);
    await openConfirm({
      me: () => json(200, { userId: "user_1", team: "org_b", role: "admin", level: "quick" }),
      deleteProduct,
    });
    await confirmDelete();

    expect(await confirm().findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
      "Warden's server isn't answering. Try again.",
    );
    expect(deleteProduct).not.toHaveBeenCalled();
  });

  it("drops a delete's answer that arrives after a Team switch", async () => {
    const answer = deferred<Response>();
    let team = "org_a";
    const bluebird = { ...SEARCH, id: "prod_b", name: "Bluebird" };
    const props = await openConfirm({
      products: () =>
        team === "org_a" ? productsAnswer([CHAT, SEARCH]) : productsAnswer([bluebird], "org_b"),
      deleteProduct: () => answer.promise,
    });
    await confirmDelete();
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));

    team = "org_b";
    props.rerender({ team });
    await screen.findByRole("heading", { level: 2, name: "Bluebird" });
    const reads = listReads().length;
    await act(async () => {
      answer.resolve(json(404, { error: "No such Product" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("This Product is no longer in your Team.")).not.toBeInTheDocument();
    expect(listReads()).toHaveLength(reads);
    expect(deleteOf("Bluebird")).toBeEnabled();
  });

  it("a Team switch forgets a delete under way: the new Team's confirm deletes at once, and the old answer leaves it busy", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let team = "org_a";
    const bluebird = { ...SEARCH, id: "prod_b", name: "Bluebird" };
    const props = await openConfirm({
      me: () => json(200, { userId: "user_1", team, role: "admin", level: "quick" }),
      products: () =>
        team === "org_a" ? productsAnswer([CHAT, SEARCH]) : productsAnswer([bluebird], "org_b"),
      deleteProduct: (id) => (id === "prod_chat" ? first.promise : second.promise),
    });
    await confirmDelete();
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));

    team = "org_b";
    props.rerender({ team });
    await screen.findByRole("heading", { level: 2, name: "Bluebird" });
    await userEvent.click(deleteOf("Bluebird"));
    const bluebirdConfirm = within(
      screen.getByRole("group", { name: "Delete Bluebird? Its CVE Findings turn Fixed." }),
    );
    const remove = bluebirdConfirm.getByRole("button", { name: "Delete" });
    expect(remove).toBeEnabled();
    await userEvent.click(remove);
    await vi.waitFor(() =>
      expect(deletes()).toEqual(["/api/products/prod_chat", "/api/products/prod_b"]),
    );

    await act(async () => {
      first.resolve(noContent());
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("aria-busy", "true");
    expect(bluebirdConfirm.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it.each([
    ["a Team switch", { team: "org_b" }, { team: "org_a" }],
    ["a Role lowered to Member", { role: "member" as Role }, { role: "admin" as Role }],
  ])(
    "closes the confirm on %s, and doesn't open it again on the way back",
    async (_case, away, back) => {
      const props = await openConfirm();
      props.rerender(away);
      expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
      props.rerender(back);
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
      expect(screen.queryByRole("group", { name: CONFIRM })).not.toBeInTheDocument();
      expect(deleteOf("Chat assistant")).toBeEnabled();
    },
  );

  it("with the frameworks failing, Delete stays enabled, and after a delete focus is on the Products heading", async () => {
    await openConfirm({
      frameworks: () => json(500, { error: "Something went wrong" }),
      deleteProduct: noContent,
    });
    expect(screen.getByRole("button", { name: "Add a Product" })).toBeDisabled();
    await confirmDelete();

    await vi.waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Products" })).toHaveFocus(),
    );
    expect(deleteOf("Search")).toBeEnabled();
  });

  it("after a delete, focus goes to Add a Product when the frameworks answered while it ran", async () => {
    const answer = deferred<Response>();
    let frameworksAnswer = false;
    await openConfirm({
      frameworks: () =>
        frameworksAnswer
          ? json(200, { frameworks: FRAMEWORKS })
          : json(500, { error: "Something went wrong" }),
      deleteProduct: () => answer.promise,
    });
    await confirmDelete();
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));

    frameworksAnswer = true;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(dependencyRows("Search")[0]).toBe("LlamaIndex 0.12.1 Library"));
    answer.resolve(noContent());

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Add a Product" })).toHaveFocus(),
    );
  });
});
