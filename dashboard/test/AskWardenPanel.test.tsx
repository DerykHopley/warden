// The Ask Warden panel in the app shell (story 9, story 3): its closed button, the Findings page opening it with the
// detail card, the card's pending Proposals from GET /api/proposals, clearing the focus, the context line and the
// placeholder chat. The whole App renders, Clerk and Warden's server faked; jsdom's window is 1024px wide, where the
// panel starts closed. Its starting state by width is tested below the UI (panel.test.ts); its layout, motion and
// keyboard in the browser (e2e/).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingProposal } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    me: () => json(200, { userId: "user_grace", team: TEAM, role: "member" }),
    findings: () => json(200, { team: TEAM, findings: demoFindings }),
    members: () => json(200, { members: [] }),
    proposals: () => proposalsAnswer(),
    ...routes,
  });
  render(<App />);
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

  it("starts closed whatever a stored value that doesn't parse says", async () => {
    localStorage.setItem("warden.askWardenPanel", "{pinned");
    open();
    await screen.findByRole("table");
    expect(queryPanel()).not.toBeInTheDocument();
    expect(askWardenButton("Ask Warden")).toBeInTheDocument();
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
    localStorage.setItem("warden.askWardenPanel", JSON.stringify({ mode: "pinned", width: 400 }));
    window.innerWidth = 1400;
    try {
      open();
      expect(await screen.findByRole("complementary", { name: "Ask Warden" })).toHaveAttribute(
        "data-shown",
        "pinned",
      );
      await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
      expect(panel()).toHaveAttribute("data-shown", "pinned");
    } finally {
      window.innerWidth = 1024;
    }
  });
});

describe("the detail card's Proposals, from GET /api/proposals", () => {
  it("lists the focused Finding's pending Proposals, and no other Finding's, naming who asked", async () => {
    open("/findings", {
      proposals: () =>
        proposalsAnswer([
          pending(),
          pending({ id: "p-2", finding_id: ID.secret, reason: "Another Finding's" }),
        ]),
    });
    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));

    const list = await within(card()).findByRole("list", { name: "Pending Proposals" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Mark False positive");
    expect(items[0]).toHaveTextContent("Only a dev dependency");
    expect(items[0]).toHaveTextContent("Asked by Grace Hopper");
    expect(screen.queryByText("Another Finding's")).not.toBeInTheDocument();
  });

  it("asks once per Team, when the card first shows, with the session token", async () => {
    open();
    await screen.findByRole("table");
    expect(callsTo("/api/proposals")).toHaveLength(0);

    await userEvent.click(await cardOf("lodash 4.17.20 has a known vulnerability"));
    await within(card()).findByRole("list", { name: "Pending Proposals" });
    await userEvent.click(await cardOf("A live Stripe secret key is committed"));
    await within(card()).findByRole("heading", { name: "A live Stripe secret key is committed" });

    expect(callsTo("/api/proposals")).toEqual([
      ["/api/proposals", { method: "GET", headers: { Authorization: "Bearer session-token" } }],
    ]);
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
    expect(contextLine()).toHaveTextContent("Talking about: a1c4e7f0 · view: Findings, Open, High");
  });

  it("without a focus, names the view", async () => {
    open("/findings");
    await screen.findByRole("table");
    await userEvent.click(askWardenButton());
    expect(contextLine()).toHaveTextContent(/^Talking about: view: Findings, Open$/);
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
