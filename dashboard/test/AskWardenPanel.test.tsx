// The Ask Warden panel in the app shell (story 9, story 3): its closed button, the Findings page opening it with the
// detail card, the card's pending Proposals from GET /api/proposals, clearing the focus, the context line, the
// placeholder chat, the person's stored choice, Esc, the divider's keys and an Organization switch. The whole App
// renders, Clerk and Warden's server faked; jsdom's window is 1024px wide, where the panel starts closed. Its starting
// state by width is tested below the UI (panel.test.ts); its layout, motion and drag in the browser (e2e/).
import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingProposal } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../src/App.tsx";
import { callsTo, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";
import { demoFindings, ID, TEAM } from "./findings-fixture.ts";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

beforeEach(() => {
  resetClerk();
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = "sess_1";
  clerk.auth.orgId = TEAM;
  clerk.orgNames = { [TEAM]: "Acme" };
  clerk.memberships = [
    {
      publicUserData: {
        userId: "user_grace",
        firstName: "Grace",
        lastName: "Hopper",
        identifier: "grace@acme.test",
      },
    },
  ];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const pending = (fields: Partial<PendingProposal> = {}): PendingProposal => ({
  id: "p-1",
  finding_id: ID.lodash,
  decision: "mark_false_positive",
  reason: "Only a dev dependency",
  until: null,
  requested_by: { kind: "person", id: "user_grace" },
  requested_at: "2026-11-24T12:30:00Z",
  state: "pending",
  decided_by: null,
  decided_at: null,
  decided_reason: null,
  stale: false,
  ...fields,
});

const proposalsAnswer = (proposals: PendingProposal[] = [pending()], team = TEAM) =>
  json(200, { team, proposals });

/** Opens `url` as a Member of TEAM, with the demo Findings and the pending Proposals answering unless `routes` says. */
function open(url = "/findings", routes: Routes = {}) {
  window.history.replaceState(null, "", url);
  serve({
    me: () => json(200, { userId: "user_grace", team: TEAM, role: "member", level: "quick" }),
    findings: () => json(200, { team: TEAM, findings: demoFindings }),
    members: () => json(200, { members: [] }),
    proposals: () => proposalsAnswer(),
    ...routes,
  });
  return render(<App />);
}

const panel = () => screen.getByRole("complementary", { name: "Ask Warden" });
const queryPanel = () => screen.queryByRole("complementary", { name: "Ask Warden" });
const askWardenButton = (name: string | RegExp = /^Ask Warden/) =>
  screen.getByRole("button", { name });
/** The detail card: the panel's first region (its Proposals section is a region inside it). */
const card = () => within(panel()).getAllByRole("region")[0]!;
const queryCard = () => within(panel()).queryAllByRole("region")[0] ?? null;
/** The "Start here" card holding `title`, once the page shows the cards. */
async function cardOf(title: string) {
  const cards = within(await screen.findByRole("list", { name: "Start here" })).getAllByRole(
    "button",
  );
  const found = cards.find((c) => within(c).queryByText(title) !== null);
  if (found === undefined) throw new Error(`no card for ${title}`);
  return found;
}
const address = () => location.pathname + location.search;

async function send(text: string) {
  const input = within(panel()).getByRole("textbox", { name: "Message" });
  await userEvent.clear(input);
  if (text !== "") await userEvent.type(input, text);
  await userEvent.click(within(panel()).getByRole("button", { name: "Send" }));
}

describe("the closed panel", () => {
  it("is a button reading Ask Warden, and after two sent messages Ask Warden · 2 messages", async () => {
    open();
    await screen.findByRole("table");
    expect(queryPanel()).not.toBeInTheDocument();

    await userEvent.click(askWardenButton("Ask Warden"));
    await send("what should I fix?");
    await send("and then?");
    await userEvent.click(within(panel()).getByRole("button", { name: "Close Ask Warden" }));

    expect(queryPanel()).not.toBeInTheDocument();
    expect(askWardenButton("Ask Warden · 2 messages")).toBeInTheDocument();
  });
});

const STORED = "warden.askWardenPanel";
const stored = () => JSON.parse(localStorage.getItem(STORED) ?? "null") as unknown;

/** Renders at `width` (jsdom's window is 1024px otherwise), and puts it back after. */
function atWidth(width: number) {
  window.innerWidth = width;
  onTestFinished(() => {
    window.innerWidth = 1024;
  });
}

describe("the person's choice", () => {
  it("is stored when they open the panel themselves, and not when selecting a Finding opens it", async () => {
    open();
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    expect(panel()).toHaveAttribute("data-shown", "floating");
    expect(stored()).toBeNull();

    await userEvent.click(within(panel()).getByRole("button", { name: "Close Ask Warden" }));
    await userEvent.click(askWardenButton());
    expect(stored()).toEqual({ mode: "floating", width: 400 });
  });

  it("stays pinned when the panel is closed where it can't pin", async () => {
    localStorage.setItem(STORED, JSON.stringify({ mode: "pinned", width: 512 }));
    open();
    expect(await screen.findByRole("complementary", { name: "Ask Warden" })).toHaveAttribute(
      "data-shown",
      "floating",
    );

    await userEvent.click(within(panel()).getByRole("button", { name: "Close Ask Warden" }));

    expect(queryPanel()).not.toBeInTheDocument();
    expect(stored()).toEqual({ mode: "pinned", width: 512 });
  });
});

describe("Esc", () => {
  it("closes a floating panel and puts focus back on its button", async () => {
    open();
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(queryPanel()).not.toBeInTheDocument();
    expect(askWardenButton()).toHaveFocus();
  });

  it.each([
    ["while an input method composes", { key: "Escape", isComposing: true }],
    ["that something else already handled", { key: "Escape" }],
  ])("leaves the panel open for an Esc %s", async (why, init) => {
    open();
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());
    const event = createEvent.keyDown(document.activeElement!, init);
    if (why.startsWith("that")) event.preventDefault();

    fireEvent(document.activeElement!, event);

    expect(panel()).toHaveAttribute("data-shown", "floating");
  });
});

describe("the divider", () => {
  const divider = () => within(panel()).getByRole("separator", { name: "Resize Ask Warden" });

  it("→ narrows and ← widens the pinned panel by 24px, within 320 to 680px, and says its width", async () => {
    atWidth(1400);
    localStorage.setItem(STORED, JSON.stringify({ mode: "pinned", width: 400 }));
    open();
    await screen.findByRole("complementary", { name: "Ask Warden" });
    expect(divider()).toHaveAttribute("aria-valuenow", "400");
    expect(divider()).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(divider()).toHaveAttribute("aria-valuenow", "376");
    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    expect(divider()).toHaveAttribute("aria-valuenow", "424");
    expect(panel().style.getPropertyValue("--panel-width")).toBe("424px");
    expect(stored()).toEqual({ mode: "pinned", width: 424 });

    for (let i = 0; i < 20; i++) fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    expect(divider()).toHaveAttribute("aria-valuenow", "680");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(divider()).toHaveAttribute("aria-valuenow", "320");
  });
});

describe("an Organization switch", () => {
  it("never paints the last Team's focused Finding in the detail card", async () => {
    const { rerender } = open();
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    expect(within(card()).getByRole("heading", { level: 3 })).toHaveTextContent("lodash 4.17.20");

    // Every detail card title painted from here on.
    const painted: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const title of node.querySelectorAll(".detail-card h3")) {
            painted.push(title.textContent ?? "");
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());

    clerk.auth.orgId = "org_b";
    clerk.orgNames.org_b = "Bluebird";
    const bluebird = demoFindings.map((f) => ({ ...f, id: `b-${f.id}`, team: "org_b" }));
    serve({
      me: () => json(200, { userId: "user_grace", team: "org_b", role: "member", level: "quick" }),
      findings: () => json(200, { team: "org_b", findings: bluebird }),
      proposals: () => proposalsAnswer([], "org_b"),
    });
    rerender(<App />);
    await screen.findByText("Bluebird");
    await screen.findByRole("table");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(painted).toEqual([]);
    expect(queryCard()).not.toBeInTheDocument();
  });
});

describe("selecting a Finding", () => {
  it.each([
    ["a card", () => cardOf("lodash 4.17.20 has a known vulnerability")],
    [
      "a row",
      async () =>
        within(await screen.findByRole("table")).getByRole("button", {
          name: /^lodash 4\.17\.20/,
        }),
    ],
  ])(
    "by %s, with the panel closed, opens it floating with that Finding's detail card",
    async (_what, target) => {
      open();
      await userEvent.click(await target());

      expect(panel()).toHaveAttribute("data-shown", "floating");
      expect(
        within(card()).getByRole("heading", { name: "lodash 4.17.20 has a known vulnerability" }),
      ).toBeInTheDocument();
    },
  );

  it("leaves a pinned panel pinned", async () => {
    localStorage.setItem(STORED, JSON.stringify({ mode: "pinned", width: 400 }));
    atWidth(1400);
    open();
    expect(await screen.findByRole("complementary", { name: "Ask Warden" })).toHaveAttribute(
      "data-shown",
      "pinned",
    );
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    expect(panel()).toHaveAttribute("data-shown", "pinned");
  });
});

// What the card shows of the list (each field, the focused Finding's only, stale, failures) is DetailCard.test.tsx's;
// here, how the panel asks for it and hands it over.
describe("the detail card's Proposals, from GET /api/proposals", () => {
  it("shows the server's Proposal for the focused Finding", async () => {
    open();
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));

    const list = await within(card()).findByRole("list", { name: "Pending Proposals" });
    expect(list).toHaveTextContent("Only a dev dependency");
  });

  it("asks when the card first shows, with the session token, and again for each Finding focused after", async () => {
    open();
    await screen.findByRole("table");
    expect(callsTo("/api/proposals")).toHaveLength(0);

    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    await within(card()).findByRole("list", { name: "Pending Proposals" });
    expect(callsTo("/api/proposals")).toEqual([
      ["/api/proposals", { method: "GET", headers: { Authorization: "Bearer session-token" } }],
    ]);

    await userEvent.click(await cardOf("A live Stripe secret key is committed"));
    await within(card()).findByRole("heading", { name: "A live Stripe secret key is committed" });
    await vi.waitFor(() => expect(callsTo("/api/proposals")).toHaveLength(2));
  });

  it("after Couldn't load Proposals, Retry asks again and shows the list", async () => {
    const answers = [json(503, { error: "Down" }), proposalsAnswer()];
    open("/findings", { proposals: () => answers.shift() ?? proposalsAnswer() });
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    await within(card()).findByText("Couldn't load Proposals");

    await userEvent.click(within(card()).getByRole("button", { name: "Retry" }));

    expect(
      await within(card()).findByRole("list", { name: "Pending Proposals" }),
    ).toHaveTextContent("Only a dev dependency");
    expect(within(card()).queryByText("Couldn't load Proposals")).not.toBeInTheDocument();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    [
      "isn't answering",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["answers 403", () => json(403, { error: "Choose a Team first" })],
    ["answers 409", () => json(409, { error: "Your Team's Admin must open Warden first" })],
    ["answers a body that doesn't parse", () => json(200, { team: TEAM, proposals: [{}] })],
  ])(
    "when the server %s, says Couldn't load Proposals and keeps the Finding's fields",
    async (_why, answer) => {
      open("/findings", { proposals: answer });
      await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));

      expect(await within(card()).findByText("Couldn't load Proposals")).toBeInTheDocument();
      expect(
        within(card()).getByRole("heading", { name: "lodash 4.17.20 has a known vulnerability" }),
      ).toBeInTheDocument();
      expect(within(card()).getByText("Evidence")).toBeInTheDocument();
    },
  );

  it("signs out when the server says the session has ended", async () => {
    open("/findings", { proposals: () => json(401, { error: "Not signed in" }) });
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    await vi.waitFor(() => expect(clerk.auth.signOut).toHaveBeenCalled());
  });

  it("asks again when the answer is about another Team, and never shows it", async () => {
    const answers = [
      proposalsAnswer([pending({ reason: "Bluebird's Proposal" })], "org_b"),
      proposalsAnswer([pending({ reason: "Acme's Proposal" })]),
    ];
    open("/findings", { proposals: () => answers.shift() ?? proposalsAnswer() });
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));

    expect(
      await within(card()).findByText("Acme's Proposal", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Bluebird's Proposal")).not.toBeInTheDocument();
    expect(callsTo("/api/proposals")).toHaveLength(2);
  });
});

describe("the card's ✕", () => {
  it("removes finding= from the URL, the selection's aria-current and the card, and leaves the panel open", async () => {
    open(`/findings?severity=high`);
    const target = await cardOf("lodash 4.17.20 has a known vulnerability");
    await userEvent.click(target);
    expect(address()).toBe(`/findings?severity=high&finding=${ID.lodash}`);
    const entries = history.length;

    await userEvent.click(within(card()).getByRole("button", { name: "Clear the focus" }));

    expect(address()).toBe("/findings?severity=high");
    expect(history.length).toBe(entries);
    expect(target).not.toHaveAttribute("aria-current");
    expect(queryCard()).not.toBeInTheDocument();
    expect(panel()).toHaveAttribute("data-shown", "floating");
  });
});

describe("the context line", () => {
  const contextLine = () => within(panel()).getByText(/^Talking about:/);

  it("with a focus, names its short id and the view", async () => {
    open(`/findings?severity=high&finding=${ID.lodash}`);
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());
    expect(contextLine()).toHaveTextContent(
      /^Talking about: a1c4e7f0 · view: Findings, Open, High$/,
    );
    expect(within(contextLine()).getByText("a1c4e7f0").tagName).toBe("CODE");
  });

  it("on People, names the page", async () => {
    open("/people");
    await screen.findByText("No one in this Team has opened Warden yet.");
    await userEvent.click(askWardenButton());
    expect(contextLine()).toHaveTextContent(/^Talking about: view: People$/);
  });
});

describe("the chat, a placeholder", () => {
  it("shows a sent message, then Warden's reply that the chat isn't connected, and asks the server nothing", async () => {
    open();
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());
    const calls = fetchMock.mock.calls.length;

    await send("what should I fix?");

    const messages = within(within(panel()).getByRole("list", { name: "Messages" }))
      .getAllByRole("listitem")
      .map((li) => [li.dataset.from, li.textContent]);
    expect(messages).toEqual([
      ["person", "what should I fix?"],
      ["warden", "Warden's chat isn't connected yet."],
    ]);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(within(panel()).getByRole("textbox", { name: "Message" })).toHaveValue("");
  });

  it.each(["", "   ", " \n\t "])("adds nothing for a blank message (%j)", async (text) => {
    open();
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());

    const input = within(panel()).getByRole("textbox", { name: "Message" });
    if (text !== "") await userEvent.type(input, text.replace("\n", ""));
    await userEvent.click(within(panel()).getByRole("button", { name: "Send" }));

    expect(within(panel()).queryAllByRole("listitem")).toEqual([]);
  });
});
