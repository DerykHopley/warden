// The Findings page (story 9): the summary line, the top 5, the table and its filters in the URL, selecting a Finding,
// and each answer GET /api/findings can get. It renders FindingsPage alone with spy props, Warden's server faked. The
// counts and orders themselves are tested below the page, in findings.test.ts.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsPage } from "../src/Findings.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { demoFindings, ID, PRODUCT_ID, SHOP_WEB, TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answer = (findings: Finding[] = demoFindings, team = TEAM) => json(200, { team, findings });

/**
 * Opens `url`, then renders FindingsPage for a person of `role` with GET /api/findings answering `list` unless `routes`
 * says otherwise.
 */
function open(
  url = "/findings",
  list: Finding[] = demoFindings,
  routes: Routes = {},
  role: Role = "member",
) {
  window.history.replaceState(null, "", url);
  serve({ findings: () => answer(list), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: TEAM, role, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
  render(<FindingsPage {...props} />);
  return props;
}

const address = () => location.pathname + location.search;
const cards = () => within(screen.getByRole("list", { name: "Start here" })).getAllByRole("button");
const table = () => screen.getByRole("table", { name: "All Findings" });
/** The table's body rows, each as its cells' text. */
const rows = () =>
  within(table())
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
const tab = (group: string, name: string) =>
  within(screen.getByRole("group", { name: group })).getByRole("button", { name });
/** The button in a row's title cell. */
const rowButton = (title: string) =>
  within(table()).getByRole("button", { name: new RegExp(`^${title.replace(".", "\\.")}`) });
const cardOf = (title: string) => {
  const card = cards().find((c) => within(c).queryByText(title) !== null);
  if (card === undefined) throw new Error(`no card for ${title}`);
  return card;
};
const current = () =>
  screen.queryAllByRole("button").filter((b) => b.getAttribute("aria-current") === "true");

describe("the summary line and the top 5", () => {
  it("shows the summary as the page's heading", async () => {
    open();
    expect(
      await screen.findByRole("heading", { level: 1, name: "7 open Findings, 2 Critical" }),
    ).toBeInTheDocument();
  });

  it("shows each card's rank, Severity word, title, evidence summary, and Asset ref and kind", async () => {
    open();
    await screen.findByRole("table");
    expect(cards()).toHaveLength(5);
    const card = within(cardOf("The agent printed a secret to the terminal"));
    expect(card.getByText("5")).toBeInTheDocument();
    expect(card.getByText("High")).toHaveClass("sev-pill");
    expect(
      card.getByText("The agent ran cat .env and its output held the Stripe key"),
    ).toBeInTheDocument();
    expect(card.getByText("session-demo-7f3a")).toBeInTheDocument();
    expect(card.getByText("Agent session")).toBeInTheDocument();
  });

  it("doesn't change when a filter changes", async () => {
    open();
    await screen.findByRole("table");
    const before = cards().map((card) => card.textContent);

    await userEvent.click(tab("Status", "Fixed"));
    await userEvent.click(tab("Severity", "Low"));

    expect(cards().map((card) => card.textContent)).toEqual(before);
  });

  const noRepos = { repos: () => json(200, { repos: [] }) };

  it("with no Findings and no linked repos, shows an Admin the summary line and the line to Setup only", async () => {
    open("/findings", [], noRepos, "admin");
    const summary = await screen.findByText("No Findings yet: they appear after the first Scan.");
    const setup = await screen.findByText(/^Connect GitHub on/);

    expect(setup).toHaveTextContent(/^Connect GitHub on Setup to run the first Scan\.$/);
    expect(within(setup).getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/setup");
    expect(summary.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Start here" })).not.toBeInTheDocument();
  });

  it.each(["lead", "member"] as const)(
    "with no Findings and no linked repos, tells a %s an Admin connects GitHub, with no link",
    async (role) => {
      open("/findings", [], noRepos, role);

      expect(
        await screen.findByText("An Admin connects GitHub on Setup to run the first Scan."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Setup" })).not.toBeInTheDocument();
    },
  );

  it.each(["admin", "member"] as const)(
    "with no Findings but linked repos, has no line to Setup (%s)",
    async (role) => {
      open(
        "/findings",
        [],
        {
          repos: () =>
            json(200, {
              repos: [
                {
                  asset: { kind: "repo", ref: "https://github.com/acme/web" },
                  installation_id: 42,
                  listed_at: "2026-11-25T09:00:00.000Z",
                  last_scan: null,
                },
              ],
            }),
        },
        role,
      );
      await screen.findByText("No Findings yet: they appear after the first Scan.");

      await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(1));
      // The repos' answer is read and rendered before the line is looked for: the call alone proves nothing.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      // Any case: an Admin's line starts "Connect GitHub on".
      expect(screen.queryByText(/connects? GitHub on/i)).not.toBeInTheDocument();
    },
  );

  it("with Findings, has no line to Setup and doesn't ask for the repos", async () => {
    open("/findings", demoFindings, noRepos);
    await screen.findByRole("table");
    expect(screen.queryByText(/connects? GitHub on/)).not.toBeInTheDocument();
    expect(callsTo("/api/repos")).toEqual([]);
  });
});

describe("the Scan now line (#342)", () => {
  const scanNow = () => screen.queryByRole("link", { name: "Scan now" });
  const linkedRepos = {
    repos: () =>
      json(200, {
        repos: [
          {
            asset: { kind: "repo", ref: "https://github.com/acme/web" },
            installation_id: 42,
            listed_at: "2026-11-25T09:00:00.000Z",
            last_scan: null,
          },
        ],
      }),
  };

  /** Waits for the one GET /api/repos, then for its answer to be read and rendered: the call alone proves nothing. */
  const reposAnswered = async () => {
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  };

  it.each(["lead", "admin"] as const)(
    "with Findings and linked repos, shows a %s 'Scan now on Setup.' under the summary line, linking to Setup's repos, once the repos answer",
    async (role) => {
      open("/findings", demoFindings, linkedRepos, role);
      const summary = await screen.findByRole("heading", { level: 1 });
      const link = await screen.findByRole("link", { name: "Scan now" });

      expect(link).toHaveAttribute("href", "/setup#setup-repos");
      const line = link.closest("p");
      expect(line).toHaveTextContent(/^Scan now on Setup\.$/);
      expect(line).toHaveClass("setup-line");
      expect(summary.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(callsTo("/api/repos")).toHaveLength(1);
    },
  );

  it.each(["lead", "admin"] as const)(
    "with Findings and no linked repos, shows a %s no Scan now line: Setup has nothing to Scan (#349)",
    async (role) => {
      open("/findings", demoFindings, { repos: () => json(200, { repos: [] }) }, role);
      await screen.findByRole("table");
      // The repos' answer is read and rendered before the line is looked for; the call is checked after, so a page that
      // shows the line without asking fails on the line.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

      expect(scanNow()).not.toBeInTheDocument();
      expect(screen.queryByText(/Scan now/)).not.toBeInTheDocument();
      expect(callsTo("/api/repos")).toHaveLength(1);
    },
  );

  it("with Findings, shows the table and summary but no Scan now while the repos haven't answered", async () => {
    const held = deferred<Response>();
    open("/findings", demoFindings, { repos: () => held.promise }, "admin");

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(1));
    expect(scanNow()).not.toBeInTheDocument();
  });

  it.each([
    ["a 403", () => json(403, { error: "no team" })],
    ["a 409", () => json(409, { error: "team not opened" })],
    ["a body that doesn't parse", () => json(200, { repos: "not a list" })],
  ])(
    "with Findings, shows no Scan now and no notice when the repos answer %s",
    async (_, repos) => {
      open("/findings", demoFindings, { repos }, "admin");
      await screen.findByRole("table");
      await reposAnswered();

      expect(scanNow()).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("with Findings, shows a Member no Scan now, and doesn't ask for the repos", async () => {
    open("/findings", demoFindings, linkedRepos, "member");
    await screen.findByRole("table");
    // Long enough for a call the page made to be seen.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText(/Scan now/)).not.toBeInTheDocument();
    expect(callsTo("/api/repos")).toEqual([]);
  });

  it.each(["lead", "admin"] as const)(
    "with no Findings but linked repos, shows a %s the Scan now line once the repos answer",
    async (role) => {
      open("/findings", [], linkedRepos, role);
      expect(await screen.findByRole("link", { name: "Scan now" })).toHaveAttribute(
        "href",
        "/setup#setup-repos",
      );
    },
  );

  it("with no Findings but linked repos, shows a Member no Scan now", async () => {
    open("/findings", [], linkedRepos, "member");
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(1));
    // The repos' answer is read and rendered before the link is looked for: the call alone proves nothing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(scanNow()).not.toBeInTheDocument();
  });

  it.each(["lead", "admin"] as const)(
    "with no Findings and no linked repos, shows a %s no Scan now: Setup has nothing to Scan",
    async (role) => {
      open("/findings", [], { repos: () => json(200, { repos: [] }) }, role);
      // Any Role: an Admin's line starts "Connect GitHub on", its "Setup" a link.
      await screen.findByText(/connects? GitHub on/i);
      expect(scanNow()).not.toBeInTheDocument();
    },
  );
});

describe("the Level line", () => {
  it("reads Level: Quick · see the journey above the summary line, from /api/me's answer, with no call of its own", async () => {
    open();
    await screen.findByRole("table");
    const line = screen.getByText(/^Level:/);

    expect(line).toHaveTextContent(/^Level: Quick · see the journey$/);
    expect(line).toHaveClass("level-line");
    expect(within(line).getByRole("link", { name: "see the journey" })).toHaveAttribute(
      "href",
      "/overview",
    );
    const summary = screen.getByRole("heading", { level: 1 });
    expect(line.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(callsTo("/api/overview")).toEqual([]);
  });
});

describe("the table", () => {
  it("lists the view's Findings with the Severity, Finding (title and Rule id), Asset and Status columns", async () => {
    open();
    await screen.findByRole("table");
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Severity", "Finding", "Asset", "Status"]);
    expect(rows()).toHaveLength(7);
    expect(rows()[0]).toEqual([
      "Critical",
      "A live Stripe secret key is committedguard/secret-in-repo · 3f2a1b9c",
      "https://github.com/acme/shop-webRepo",
      "Open",
    ]);
  });

  it("shows the Unconfirmed fix flag beside a Fixed Finding's Status", async () => {
    open("/findings?status=fixed");
    await screen.findByRole("table");
    expect(rows().map((cells) => cells[3])).toEqual(["FixedUnconfirmed fix", "Fixed"]);
  });

  it("says Nothing matches this view. when no Finding matches", async () => {
    open("/findings?status=accepted&severity=critical");
    await screen.findByRole("table");
    expect(rows()).toEqual([["Nothing matches this view."]]);
  });
});

describe("the filter tabs", () => {
  it("offers each group's choices, the defaults chosen", async () => {
    open();
    await screen.findByRole("table");
    const names = (group: string) =>
      within(screen.getByRole("group", { name: group }))
        .getAllByRole("button")
        .map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`);
    expect(names("Status")).toEqual([
      "Open*",
      "Accepted",
      "Fixed",
      "False positive",
      "Every status",
    ]);
    expect(names("Severity")).toEqual(["Any severity*", "Critical", "High", "Medium", "Low"]);
    expect(names("Module")).toEqual(["Any module*", "Guard", "Patch", "Vouch"]);
  });

  it("swaps the table and pushes the URL at once, and shows the new view path at the right", async () => {
    open();
    await screen.findByRole("table");
    const entries = history.length;

    await userEvent.click(tab("Severity", "High"));

    expect(address()).toBe("/findings?severity=high");
    expect(history.length).toBe(entries + 1);
    expect(tab("Severity", "High")).toHaveAttribute("aria-pressed", "true");
    expect(rows().map((cells) => cells[0])).toEqual(["High", "High", "High"]);
    expect(screen.getByText("/findings?severity=high")).toHaveClass("view-path");
  });

  it("adds no history entry for a tab that's already chosen, so Back still steps to the last view", async () => {
    open();
    await screen.findByRole("table");
    const entries = history.length;

    await userEvent.click(tab("Status", "Fixed"));
    await userEvent.click(tab("Status", "Fixed"));

    expect(history.length).toBe(entries + 1);
    expect(address()).toBe("/findings?status=fixed");
  });

  it("follows Back to the last view", async () => {
    open();
    await screen.findByRole("table");
    await userEvent.click(tab("Severity", "High"));
    await userEvent.click(tab("Severity", "Low"));

    history.back();
    await vi.waitFor(() => expect(address()).toBe("/findings?severity=high"));
    await vi.waitFor(() => expect(tab("Severity", "High")).toHaveAttribute("aria-pressed", "true"));
    expect(rows()).toHaveLength(3);
  });
});

describe("a view in the URL", () => {
  it("opens the view it names", async () => {
    open("/findings?status=fixed&severity=high");
    await screen.findByRole("table");
    expect(tab("Status", "Fixed")).toHaveAttribute("aria-pressed", "true");
    expect(tab("Severity", "High")).toHaveAttribute("aria-pressed", "true");
    expect(rows()).toHaveLength(2);
    expect(address()).toBe("/findings?status=fixed&severity=high");
  });

  it("shows Open for an unknown status, and rewrites the address without adding to history", async () => {
    window.history.replaceState(null, "", "/findings?status=nope");
    const entries = history.length;
    open("/findings?status=nope");
    await screen.findByRole("table");
    expect(tab("Status", "Open")).toHaveAttribute("aria-pressed", "true");
    expect(address()).toBe("/findings");
    expect(history.length).toBe(entries);
  });
});

describe("selecting a Finding", () => {
  it("by a click on a card: the card and its row's button are current, and finding=<id> replaces the URL", async () => {
    open();
    await screen.findByRole("table");
    const entries = history.length;

    await userEvent.click(cardOf("lodash 4.17.20 has a known vulnerability"));

    expect(current()).toEqual([
      cardOf("lodash 4.17.20 has a known vulnerability"),
      rowButton("lodash 4.17.20 has a known vulnerability"),
    ]);
    expect(rowButton("lodash 4.17.20").closest("tr")).toHaveClass("selected");
    expect(address()).toBe(`/findings?finding=${ID.lodash}`);
    expect(history.length).toBe(entries);
  });

  it("by a click anywhere on a row, and by Enter or Space on a row's button", async () => {
    open();
    await screen.findByRole("table");

    await userEvent.click(within(table()).getByText("ada-laptop"));
    expect(current()).toEqual([rowButton("The disk isn't encrypted")]);
    expect(address()).toBe(`/findings?finding=${ID.disk}`);

    rowButton("@aws-sdk").focus();
    await userEvent.keyboard("{Enter}");
    expect(address()).toBe(`/findings?finding=${ID.cognito}`);

    rowButton("minimist").focus();
    await userEvent.keyboard(" ");
    expect(address()).toBe(`/findings?finding=${ID.minimist}`);
    expect(cardOf("minimist 1.2.5 has a known vulnerability")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("keeps the selection when the page opens again at its URL (a reload or a shared link)", async () => {
    open(`/findings?severity=critical&finding=${ID.lodash}`);
    await screen.findByRole("table");
    expect(current()).toEqual([
      cardOf("lodash 4.17.20 has a known vulnerability"),
      rowButton("lodash 4.17.20"),
    ]);
    expect(address()).toBe(`/findings?severity=critical&finding=${ID.lodash}`);
  });

  it("selects nothing for an id the Team's list doesn't have, and drops it from the URL", async () => {
    const { panel } = open("/findings?severity=high&finding=not-ours");
    await screen.findByRole("table");
    await vi.waitFor(() => expect(address()).toBe("/findings?severity=high"));
    expect(current()).toEqual([]);
    expect(panel.open).not.toHaveBeenCalled();
  });
});

describe("a link that names a Finding", () => {
  it("opens the panel as selecting it does, once the Team's list holds it", async () => {
    const { panel } = open(`/findings?finding=${ID.lodash}`);
    expect(panel.open).not.toHaveBeenCalled();
    await screen.findByRole("table");
    // The page opens the panel in a passive effect, which React runs after the commit that put the table in, in a
    // later task under load: wait for the effect, not only for the table.
    await vi.waitFor(() => expect(panel.open).toHaveBeenCalledTimes(1));
  });

  it("opens it only on the page's load, not again when the list comes back", async () => {
    const { panel } = open(`/findings?finding=${ID.lodash}`);
    await screen.findByRole("table");
    const context = panel.setContext.mock.lastCall?.[0] as { onFindingChanged: () => void };

    context.onFindingChanged();
    await vi.waitFor(() => expect(callsTo("/api/findings")).toHaveLength(2));
    await screen.findByRole("table");

    expect(panel.open).toHaveBeenCalledTimes(1);
  });

  it("doesn't open it for a page load that names no Finding", async () => {
    const { panel } = open("/findings?severity=high");
    await screen.findByRole("table");
    expect(panel.open).not.toHaveBeenCalled();
  });
});

describe("a Product Asset's name", () => {
  // The lodash Finding on a saved Product (its ref the Product's id); minimist keeps the demo seed's made-up "shop".
  const onProduct = demoFindings.map((f) =>
    f.id === ID.lodash ? { ...f, asset: { kind: "product" as const, ref: PRODUCT_ID } } : f,
  );
  const products = (team = TEAM) => json(200, { team, products: [SHOP_WEB] });
  const LODASH = "lodash 4.17.20 has a known vulnerability";
  const MINIMIST = "minimist 1.2.5 has a known vulnerability";
  /** The Asset cell of the row titled `title`. */
  const assetCell = (title: string) =>
    rowButton(title).closest("tr")?.querySelector(".asset-col")?.textContent;
  /** The table's link on Shop web's name, once the table and the Products have come. */
  const shopWebLink = async () =>
    within(await screen.findByRole("table", { name: "All Findings" })).findByRole("link", {
      name: "Shop web",
    });

  it("shows the Product's name and Product in its row and card, not the id; a ref no Product has stays", async () => {
    open("/findings", onProduct, { products: () => products() });
    await vi.waitFor(() => expect(assetCell(LODASH)).toBe("Shop webProduct"));
    expect(within(cardOf(LODASH)).getByText("Shop web")).toHaveClass("asset-ref");
    expect(within(cardOf(LODASH)).getByText("Product")).toBeInTheDocument();
    expect(screen.queryByText(PRODUCT_ID)).not.toBeInTheDocument();
    expect(assetCell(MINIMIST)).toBe("shopProduct");
  });

  it("links the Product's name in its row to its entry on Products; a ref no Product has, and a card, link nothing", async () => {
    open("/findings", onProduct, { products: () => products() });
    const link = await shopWebLink();
    expect(link).toHaveAttribute("href", `/products#product-${PRODUCT_ID}`);
    expect(link).toHaveClass("asset-ref");
    expect(within(table()).getAllByRole("link")).toEqual([link]);
    // A Start here card is a button: it holds no link.
    expect(within(cardOf(LODASH)).queryByRole("link")).toBeNull();
  });

  it("follows the link without selecting its row", async () => {
    const { panel } = open("/findings", onProduct, { products: () => products() });
    const link = await shopWebLink();
    // jsdom doesn't load another page: the link's own way there is stopped before it starts.
    const stay = (event: Event) => event.preventDefault();
    window.addEventListener("click", stay, true);
    try {
      await userEvent.click(link);
    } finally {
      window.removeEventListener("click", stay, true);
    }
    expect(panel.open).not.toHaveBeenCalled();
    expect(current()).toEqual([]);
  });

  it.each<[string, Routes]>([
    ["isn't answering", {}],
    ["answers 403", { products: () => json(403, { error: "no Team" }) }],
  ])("shows each ref, and no refusal, when GET /api/products %s", async (_case, routes) => {
    open("/findings", onProduct, routes);
    await vi.waitFor(() => expect(callsTo("/api/products")).toHaveLength(1));
    await screen.findByRole("table");
    expect(assetCell(LODASH)).toBe(`${PRODUCT_ID}Product`);
    expect(within(cardOf(LODASH)).getByText(PRODUCT_ID)).toHaveClass("asset-ref");
    expect(within(table()).queryAllByRole("link")).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("names nothing from an answer about another Team", async () => {
    open("/findings", onProduct, { products: () => products("org_b") });
    await vi.waitFor(() => expect(callsTo("/api/products")).toHaveLength(4), { timeout: 3000 });
    expect(assetCell(LODASH)).toBe(`${PRODUCT_ID}Product`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives the panel the focused Finding's Product name, or null when no Product has its ref", async () => {
    const { panel } = open(`/findings?finding=${ID.lodash}`, onProduct, {
      products: () => products(),
    });
    const productName = () =>
      (panel.setContext.mock.lastCall?.[0] as { productName: string | null } | null)?.productName;
    await vi.waitFor(() => expect(productName()).toBe("Shop web"));

    await userEvent.click(rowButton(MINIMIST));
    expect(productName()).toBeNull();
  });
});

describe("waiting and refusals", () => {
  it("shows Loading Findings… until the answer arrives, asking with the session token", async () => {
    const late = deferred<Response>();
    open("/findings", demoFindings, { findings: () => late.promise });
    expect(screen.getByText("Loading Findings…")).toBeInTheDocument();
    late.resolve(answer());
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("Loading Findings…")).not.toBeInTheDocument();
    expect(callsTo("/api/findings")[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("asks again when the answer is about another Team, and shows the one about this Team", async () => {
    const answers = [answer(demoFindings, "org_b"), answer()];
    open("/findings", demoFindings, { findings: () => answers.shift() ?? answer() });
    expect(await screen.findByRole("table", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(callsTo("/api/findings")).toHaveLength(2);
  });

  it("after three more answers about another Team, says the server isn't answering", async () => {
    open("/findings", demoFindings, { findings: () => answer(demoFindings, "org_b") });
    expect(
      await screen.findByText("Warden's server isn't answering", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(callsTo("/api/findings")).toHaveLength(4);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says the server isn't answering when it can't be reached, and Retry asks again", async () => {
    let answered = 0;
    open("/findings", demoFindings, {
      findings: () => {
        answered += 1;
        if (answered === 1) throw new TypeError("Failed to fetch");
        return answer();
      },
    });
    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("counts a body that doesn't parse as not answering", async () => {
    open("/findings", demoFindings, {
      findings: () => json(200, { team: TEAM, findings: [{ ...demoFindings[0], status: "gone" }] }),
    });
    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
  });

  it("shows the too-many-attempts notice on a 429", async () => {
    open("/findings", demoFindings, {
      findings: () => json(429, { error: "Too many sign-in attempts" }, { "Retry-After": "12" }),
    });
    expect(
      await screen.findByText("Too many sign-in attempts. Try again in 12 seconds."),
    ).toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    const props = open("/findings", demoFindings, {
      findings: () => json(401, { error: "Not signed in" }),
    });
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
  });

  it("asks to choose a Team on a 403", async () => {
    open("/findings", demoFindings, {
      findings: () => json(403, { error: "Choose a Team first" }),
    });
    expect(
      await screen.findByText("Choose a Team first, from the switcher above."),
    ).toBeInTheDocument();
  });

  it("says the Team's Admin must open Warden first on a 409", async () => {
    open("/findings", demoFindings, { findings: () => json(409, { error: "Open it first" }) });
    expect(
      await screen.findByText(
        "Your Team's Admin must open Warden first. Try again once they have.",
      ),
    ).toBeInTheDocument();
  });
});
