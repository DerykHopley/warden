// The app shell's header and its Team: the Team's name from Clerk, the Role from /api/me, and an Organization switch.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { callsTo, deferred, fetchMock, json, noContent, serve } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

beforeEach(() => {
  resetClerk();
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = "sess_1";
  clerk.orgNames = { org_a: "Acme", org_b: "Bluebird" };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const header = () => within(screen.getByRole("banner"));
const me = (team: string | null, role: string | null) =>
  json(200, { userId: "user_1", team, role, level: team === null ? null : "quick" });

const overview = (team = "org_a") =>
  json(200, {
    team,
    level: "quick",
    audit: { answer: "no_catalogue", gaps: 0, waiting: 0, controls: [] },
    last_scan_at: null,
    has_findings: false,
    period_days: 30,
    open_at_start: 0,
    open_now: 0,
    fix_rate: { fixed: 0, of: 0 },
  });

const headerLinks = () =>
  header()
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);

describe("the landing page by Role", () => {
  it("at /, takes a Member to Findings without a new history entry, with the header's links Findings, Overview, Products, People", async () => {
    clerk.auth.orgId = "org_a";
    serve({
      me: () => me("org_a", "member"),
      findings: () => json(200, { team: "org_a", findings: [] }),
    });
    const entries = history.length;
    render(<App />);

    expect(
      await screen.findByText("No Findings yet: they appear after the first Scan."),
    ).toBeInTheDocument();
    expect(location.pathname).toBe("/findings");
    expect(history.length).toBe(entries);
    expect(headerLinks()).toEqual([
      ["Findings", "/findings"],
      ["Overview", "/overview"],
      ["Products", "/products"],
      ["People", "/people"],
      ["Setup", "/setup"],
    ]);
    expect(header().getByRole("link", { name: "Findings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(header().getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(header().getByRole("link", { name: "Products" })).not.toHaveAttribute("aria-current");
    expect(header().getByRole("link", { name: "People" })).not.toHaveAttribute("aria-current");
  });

  it.each(["lead", "admin"])(
    "at /, takes a %s to Overview without a new history entry, its header link current",
    async (role) => {
      clerk.auth.orgId = "org_a";
      serve({ me: () => me("org_a", role), overview: () => overview() });
      const entries = history.length;
      render(<App />);

      expect(
        await screen.findByText("No Findings yet: the trend starts after the first Scan."),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
      expect(location.pathname).toBe("/overview");
      expect(history.length).toBe(entries);
      expect(headerLinks()).toEqual([
        ["Findings", "/findings"],
        ["Overview", "/overview"],
        ["Products", "/products"],
        ["People", "/people"],
        ["Setup", "/setup"],
      ]);
      expect(header().getByRole("link", { name: "Overview" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(header().getByRole("link", { name: "Findings" })).not.toHaveAttribute("aria-current");
      expect(callsTo("/api/findings")).toHaveLength(0);
    },
  );

  it("on Overview, the Ask Warden panel talks about the page, with no detail card", async () => {
    window.history.replaceState(null, "", "/overview");
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "admin"), overview: () => overview() });
    render(<App />);
    await screen.findByText("No Findings yet: the trend starts after the first Scan.");

    await userEvent.click(screen.getByRole("button", { name: "Ask Warden" }));

    const panel = within(screen.getByRole("complementary", { name: "Ask Warden" }));
    expect(panel.getByText(/^Talking about:/)).toHaveTextContent(/^Talking about: view: Overview$/);
    expect(panel.queryAllByRole("region")).toEqual([]);
  });

  it("at /, shows the shell's waiting line and no page while /api/me hasn't answered", async () => {
    clerk.auth.orgId = "org_a";
    const late = deferred<Response>();
    serve({ me: () => late.promise, findings: () => json(200, { team: "org_a", findings: [] }) });
    render(<App />);

    expect(screen.getByText("Checking your session with Warden's server…")).toBeInTheDocument();
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(1));
    expect(callsTo("/api/findings")).toHaveLength(0);
    expect(location.pathname).toBe("/");

    late.resolve(me("org_a", "member"));
    await vi.waitFor(() => expect(location.pathname).toBe("/findings"));
  });

  it("keeps a page the address names: /people stays People", async () => {
    window.history.replaceState(null, "", "/people");
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "member"), members: () => json(200, { members: [] }) });
    render(<App />);

    expect(
      await screen.findByText("No one in this Team has opened Warden yet."),
    ).toBeInTheDocument();
    expect(location.pathname).toBe("/people");
    expect(header().getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["/setup", "Setup"],
    ["/setup/github", "Connect GitHub"],
    ["/setup/github/callback", "Connect GitHub"],
    ["/setup/github/write", "Grant write access"],
    ["/setup/github/write/callback", "Grant write access"],
  ])("at %s, shows the %s page with the header's Setup link current", async (path, heading) => {
    window.history.replaceState(null, "", path);
    clerk.auth.orgId = "org_a";
    serve({
      me: () => me("org_a", "member"),
      repos: () => json(200, { repos: [] }),
      writeGrant: () => json(200, { installations: [] }),
    });
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(location.pathname).toBe(path);
    expect(header().getByRole("link", { name: "Setup" })).toHaveAttribute("aria-current", "page");
    expect(header().getByRole("link", { name: "People" })).not.toHaveAttribute("aria-current");
  });

  it("at /products, shows the Products page, its header link current, and the panel talks about it", async () => {
    window.history.replaceState(null, "", "/products");
    clerk.auth.orgId = "org_a";
    serve({
      me: () => me("org_a", "member"),
      products: () => json(200, { team: "org_a", products: [] }),
      frameworks: () => json(200, { frameworks: [] }),
    });
    render(<App />);

    expect(await screen.findByText("No Products yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Products" })).toBeInTheDocument();
    expect(location.pathname).toBe("/products");
    expect(header().getByRole("link", { name: "Products" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(header().getByRole("link", { name: "People" })).not.toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("button", { name: "Ask Warden" }));
    const panel = within(screen.getByRole("complementary", { name: "Ask Warden" }));
    expect(panel.getByText(/^Talking about:/)).toHaveTextContent(/^Talking about: view: Products$/);
  });
});

describe("AppShell", () => {
  it("shows the Team's name, the Role as a word, the Organization switcher and Sign out", async () => {
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "admin"), members: () => json(200, { members: [] }) });
    render(<App />);

    expect(await header().findByText("Admin")).toBeInTheDocument();
    expect(header().getByText("Acme")).toBeInTheDocument();
    expect(header().getByText("Warden")).toBeInTheDocument();
    expect(header().getByText("Clerk organization switcher")).toBeInTheDocument();
    expect(header().getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(header().getByRole("link", { name: "People" })).toHaveAttribute("href", "/people");
    // "Personal account" is never a choice: Warden works only inside a Team.
    expect(clerk.switcherProps.at(-1)).toMatchObject({ hidePersonal: true });
  });

  it("with no active Organization, asks the person to create or choose a Team, and shows no Role", async () => {
    serve({ me: () => me(null, null) });
    render(<App />);

    expect(
      await screen.findByText("Create a Team, or choose one you've been invited to"),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Clerk organization switcher");
    for (const word of ["Member", "Lead", "Admin"]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
    expect(callsTo("/api/team/members")).toHaveLength(0);
  });

  it("on an Organization switch, asks again for the person's Role and the Team's people", async () => {
    window.history.replaceState(null, "", "/people");
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "admin"), members: () => json(200, { members: [] }) });
    const { rerender } = render(<App />);
    expect(await header().findByText("Admin")).toBeInTheDocument();
    await screen.findByText("No one in this Team has opened Warden yet.");
    expect(callsTo("/api/me")).toHaveLength(1);
    expect(callsTo("/api/team/members")).toHaveLength(1);

    clerk.auth.orgId = "org_b";
    serve({ me: () => me("org_b", "lead"), members: () => json(200, { members: [] }) });
    rerender(<App />);

    expect(await header().findByText("Lead")).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
    await screen.findByText("No one in this Team has opened Warden yet.");
    expect(callsTo("/api/me")).toHaveLength(2);
    expect(callsTo("/api/team/members")).toHaveLength(2);
  });

  it("drops a slow answer for the Team the person switched away from", async () => {
    clerk.auth.orgId = "org_a";
    const slowA = deferred<Response>();
    serve({ me: () => slowA.promise, members: () => json(200, { members: [] }) });
    const { rerender } = render(<App />);
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(1));

    clerk.auth.orgId = "org_b";
    const slowB = deferred<Response>();
    serve({ me: () => slowB.promise, members: () => json(200, { members: [] }) });
    rerender(<App />);
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(2));

    slowA.resolve(me("org_a", "admin"));
    // Team A's answer arrives while Team B is active: it never shows, and the header waits for Team B's.
    await new Promise((r) => setTimeout(r, 0));
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
    expect(header().queryByText("Acme")).not.toBeInTheDocument();
    expect(header().getAllByText("…")).toHaveLength(2);

    slowB.resolve(me("org_b", "member"));
    expect(await header().findByText("Member")).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
  });

  it("asks again when the server answers about another Team, and shows the answer about this one", async () => {
    clerk.auth.orgId = "org_b";
    const answers = [me("org_a", "admin"), me("org_b", "lead")];
    serve({
      me: () => answers.shift() ?? me("org_b", "lead"),
      members: () => json(200, { members: [] }),
    });
    render(<App />);

    expect(await header().findByText("Lead", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(2);
  });

  it("stops asking after three tries about another Team, and offers Retry", async () => {
    clerk.auth.orgId = "org_b";
    serve({ me: () => me("org_a", "admin") });
    render(<App />);

    expect(
      await screen.findByText("Warden's server isn't answering", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
  });
});

// The shell shows its waiting line while /api/me answers about the new Team, so a Team switch mounts a fresh page:
// a change sent from the page left behind still reaches the list shown once the person is back on its Team (#307).
describe("a change on Products under way across a Team switch and back", () => {
  const CHAT = { id: "prod_chat", name: "Chat assistant", repo_urls: [], dependencies: [] };
  const DOCS_BOT = { id: "prod_docs", name: "Docs bot", repo_urls: [], dependencies: [] };
  const BLUEBIRD = { id: "prod_b", name: "Bluebird", repo_urls: [], dependencies: [] };

  /**
   * Opens /products as an Admin of Acme, the Team's Products read from `stored` (Bluebird's from its own list), and
   * holds each save and delete until the test answers it.
   */
  async function openProducts(stored: () => unknown[]) {
    window.history.replaceState(null, "", "/products");
    clerk.auth.orgId = "org_a";
    const save = deferred<Response>();
    const remove = deferred<Response>();
    serve({
      me: () => me(clerk.auth.orgId, "admin"),
      products: () =>
        clerk.auth.orgId === "org_b"
          ? json(200, { team: "org_b", products: [BLUEBIRD] })
          : json(200, { team: "org_a", products: stored() }),
      frameworks: () => json(200, { frameworks: [] }),
      saveProduct: () => save.promise,
      deleteProduct: () => remove.promise,
    });
    const { rerender } = render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    /** Switches to Bluebird and back to Acme, each once its list shows. */
    const awayAndBack = async () => {
      clerk.auth.orgId = "org_b";
      rerender(<App />);
      await screen.findByRole("heading", { level: 2, name: "Bluebird" });
      clerk.auth.orgId = "org_a";
      rerender(<App />);
      await screen.findByRole("heading", { level: 2, name: "Chat assistant" });
    };
    return { save, remove, awayAndBack };
  }

  const sent = (method: string) =>
    fetchMock.mock.calls.filter(
      ([input, init]) => String(input).startsWith("/api/products") && init?.method === method,
    );

  it("a save the server stores while the Admin is on another Team shows in the list once they're back", async () => {
    let stored = [CHAT];
    const { save, awayAndBack } = await openProducts(() => stored);
    await userEvent.click(screen.getByRole("button", { name: "Add a Product" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Docs bot");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(sent("POST")).toHaveLength(1));

    await awayAndBack();
    stored = [CHAT, DOCS_BOT];
    save.resolve(json(201, DOCS_BOT));

    expect(await screen.findByRole("heading", { level: 2, name: "Docs bot" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a delete the server makes while the Admin is on another Team leaves the list once they're back", async () => {
    let stored = [CHAT, DOCS_BOT];
    const { remove, awayAndBack } = await openProducts(() => stored);
    await userEvent.click(screen.getByRole("button", { name: "Delete Chat assistant" }));
    const confirm = within(
      screen.getByRole("group", { name: "Delete Chat assistant? Its CVE Findings turn Fixed." }),
    );
    await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(sent("DELETE")).toHaveLength(1));

    await awayAndBack();
    stored = [DOCS_BOT];
    remove.resolve(noContent());

    await vi.waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "Chat assistant" })).toBeNull(),
    );
    expect(screen.getByRole("heading", { level: 2, name: "Docs bot" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
