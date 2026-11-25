// The detail card (story 9, story 3, story 4): the focused Finding's fields in the dashboard's words, then its pending
// Proposals; a Lead's decisions and a Member's Proposals on it, and a Lead's approval or rejection of a Proposal. It
// renders DetailCard alone, Warden's server faked; how the panel asks for the Proposals, and how a decision reaches
// the Findings table, is in AskWardenPanel.test.tsx. The until's time-zone rule is decisions.test.ts's.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AcceptBody,
  ProposeBody,
  type Finding,
  type Location,
  type PendingProposal,
  type Proposal,
  type Role,
} from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayWords } from "../src/date-words.ts";
import { DetailCard } from "../src/DetailCard.tsx";
import { earliestUntil } from "../src/decisions.ts";
import type { ProposalsResult } from "../src/proposals.ts";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { finding, TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "3f9a1c2e-0000-4000-8000-000000000001";
const OTHER = "a1c4e7f0-0000-4000-8000-000000000002";

/**
 * `wallClock` ("2027-02-22T12:00") in the person's own time zone, as the server answers a date-time. A fixture's day is
 * then the day the card shows in every time zone, where a fixed UTC noon falls on the next day at UTC+13 and UTC+14.
 */
const localAt = (wallClock: string) => new Date(wallClock).toISOString();

const proposal = (fields: Partial<PendingProposal> = {}): PendingProposal => ({
  id: "p-1",
  finding_id: ID,
  decision: "mark_false_positive",
  reason: "The file is a test fixture",
  until: null,
  requested_by: { kind: "person", id: "user_grace" },
  requested_at: localAt("2026-11-24T12:30"),
  state: "pending",
  decided_by: null,
  decided_at: null,
  decided_reason: null,
  stale: false,
  ...fields,
});

const listed = (proposals: PendingProposal[]): ProposalsResult => ({
  kind: "proposals",
  team: TEAM,
  proposals,
});

const clerkUsers = new Map([
  ["user_grace", { firstName: "Grace", lastName: "Hopper", identifier: "grace@acme.test" }],
  ["user_ada", { firstName: null, lastName: null, identifier: "ada@acme.test" }],
]);

/** The signed-in person's user id. */
const ME = "user_me";

type Shown = { role?: Role | null; candidates?: Finding[] };

/** Renders the card for `focused`, as a person with `role` (null: not loaded yet). */
function show(
  focused: Finding,
  proposals: ProposalsResult | "loading" = listed([]),
  { role = null, candidates = [] }: Shown = {},
) {
  const calls = {
    onClear: vi.fn(),
    onRetry: vi.fn(),
    onFindingChanged: vi.fn(),
    onFindingGone: vi.fn(),
    onProposalsChanged: vi.fn(),
    refreshMe: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  const element = (shown: Finding, listedNow: ProposalsResult | "loading") => (
    <DetailCard
      finding={shown}
      proposals={listedNow}
      clerkUsers={clerkUsers}
      role={role}
      userId={ME}
      getToken={() => Promise.resolve("session-token")}
      candidates={candidates}
      onClear={calls.onClear}
      onRetryProposals={calls.onRetry}
      onFindingChanged={calls.onFindingChanged}
      onFindingGone={calls.onFindingGone}
      onProposalsChanged={calls.onProposalsChanged}
      refreshMe={calls.refreshMe}
      onSessionEnded={calls.onSessionEnded}
    />
  );
  const { rerender, unmount } = render(element(focused, proposals));
  return {
    card: within(screen.getByRole("region", { name: focused.title })),
    ...calls,
    /** The card again, as the page hands it a changed Finding or Proposals list. */
    update: (shown: Finding, listedNow = proposals) => rerender(element(shown, listedNow)),
    /** The card goes, as when the focus is cleared or moves to another Finding. */
    unmount,
  };
}

/** Each field's label and value, as the card's definition list holds them. */
const fields = (card: ReturnType<typeof show>["card"]) =>
  Object.fromEntries(
    card
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
  );

describe("the detail card's Finding", () => {
  it("shows its short id, module and Rule id in mono, its title, Severity, Status, Asset and evidence summary", () => {
    const { card } = show(finding(ID, { severity: "critical", status: "open" }));
    const ids = card.getByText("3f9a1c2e · Guard · guard/agent-can-read-env");
    expect(ids.tagName).toBe("CODE");
    expect(card.getByRole("heading", { name: "The agent can read .env files" })).toBeVisible();
    expect(card.getByText("Critical")).toHaveClass("sev-pill");
    expect(card.getByText("Open")).toBeInTheDocument();
    expect(fields(card)).toMatchObject({
      Asset: "Repo https://github.com/acme/shop-web",
      Evidence: "permissions.allow lets the agent read .env",
    });
  });

  it.each<[string, Location, string]>([
    ["a file with a line", { kind: "file", path: ".env", line: 3 }, ".env:3"],
    [
      "a file without a line",
      { kind: "file", path: ".claude/settings.json" },
      ".claude/settings.json",
    ],
    [
      "a dependency with a vulnerability",
      {
        kind: "dependency",
        package: "lodash",
        version: "4.17.20",
        vulnerability: "CVE-2021-23337",
      },
      "lodash 4.17.20 · CVE-2021-23337",
    ],
    [
      "a dependency without a vulnerability",
      { kind: "dependency", package: "minimist", version: "1.2.5" },
      "minimist 1.2.5",
    ],
    ["a setting", { kind: "setting", name: "FileVault" }, "FileVault"],
  ])("shows the Location of %s", (_kind, location, words) => {
    const { card } = show(finding(ID, { location }));
    expect(fields(card).Location).toBe(words);
  });

  it("shows a session's Location as the whole session", () => {
    const session = finding(ID, {
      asset: { kind: "agent_session", ref: "session-demo-7f3a" },
      location: { kind: "session" },
      evidence: {
        summary: "The agent ran cat .env",
        session: {
          events: [{ seq: 0, at: "2026-11-24T09:00:00Z", name: "PreToolUse", text: "cat .env" }],
          events_read: 1,
          events_hash: `sha256:${"0".repeat(64)}`,
        },
      },
    });
    const { card } = show(session);
    expect(fields(card)).toMatchObject({
      Asset: "Agent session session-demo-7f3a",
      Location: "the whole session",
    });
  });

  it("shows a secret's type, path, line and mask, and no other evidence field", () => {
    const { card } = show(
      finding(ID, {
        rule_id: "guard/committed-secret",
        evidence: {
          summary: "A Stripe key sits in .env",
          secret: { type: "Stripe secret key", path: ".env", line: 3, mask: "sk_live_****9f2c" },
        },
      }),
    );
    expect(fields(card)).toEqual({
      Asset: "Repo https://github.com/acme/shop-web",
      Location: ".claude/settings.json",
      Evidence: "A Stripe key sits in .env",
      Secret: "Stripe secret key at .env:3, sk_live_****9f2c",
    });
  });

  it("shows its Control's Catalogue and ref when it has one", () => {
    const { card } = show(finding(ID, { control: { catalogue: "SOC 2", ref: "CC6.1" } }));
    expect(fields(card).Control).toBe("SOC 2 CC6.1");
  });

  it("shows an Accepted Finding's reason and until date, as the day it reopens on", () => {
    const { card } = show(
      finding(ID, {
        status: "accepted",
        accepted_reason: "Fixed next sprint",
        accepted_until: localAt("2027-02-22T12:00"),
      }),
    );
    expect(card.getByText("Accepted")).toBeInTheDocument();
    expect(fields(card)).toMatchObject({
      "Accepted because": "Fixed next sprint",
      "Reopens on": "Feb 22, 2027",
    });
    expect(fields(card)).not.toHaveProperty("Until");
  });

  it("shows the Unconfirmed fix flag with its number of candidates", () => {
    const { card } = show(
      finding(ID, { status: "fixed", unconfirmed_fix: { candidates: [OTHER, "b-2"] } }),
    );
    expect(card.getByText("Fixed")).toBeInTheDocument();
    expect(card.getByText("Unconfirmed fix: 2 candidates")).toHaveClass("flag");
  });

  it("✕ clears the focus", async () => {
    const { card, onClear } = show(finding(ID));
    await userEvent.click(card.getByRole("button", { name: "Clear the focus" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

type Card = ReturnType<typeof show>["card"];

const proposalItems = (card: Card) =>
  within(card.getByRole("list", { name: "Pending Proposals" })).getAllByRole("listitem");

describe("the detail card's pending Proposals", () => {
  it("reads Asked by you on the signed-in person's own, their name on another person's, and an agent on an agent's", () => {
    const { card } = show(
      finding(ID),
      listed([
        proposal({ id: "p-mine", requested_by: { kind: "person", id: ME } }),
        proposal({ id: "p-grace" }),
        proposal({ id: "p-agent", requested_by: { kind: "agent", id: "guard-bot" } }),
      ]),
    );
    const [mine, grace, agent] = proposalItems(card);
    expect(mine).toHaveTextContent(/Asked by you, Nov 24, 2026/);
    expect(grace).toHaveTextContent(/Asked by Grace Hopper, Nov 24, 2026/);
    expect(agent).toHaveTextContent(/Asked by an agent, Nov 24, 2026/);
  });

  it("lists the focused Finding's, and no other Finding's, each with decision, reason, until, who asked and when", () => {
    const { card } = show(
      finding(ID),
      listed([
        proposal(),
        proposal({ id: "p-other", finding_id: OTHER, reason: "Another Finding's" }),
        proposal({
          id: "p-2",
          decision: "accept",
          reason: "Fixed next sprint",
          until: localAt("2027-01-15T12:00"),
          requested_by: { kind: "person", id: "user_ada" },
        }),
        proposal({ id: "p-3", requested_by: { kind: "agent", id: "guard-bot" } }),
        proposal({ id: "p-4", requested_by: { kind: "person", id: "user_gone" } }),
      ]),
    );

    const items = proposalItems(card);
    expect(items).toHaveLength(4);
    expect(card.queryByText("Another Finding's")).not.toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Mark False positive");
    expect(items[0]).toHaveTextContent("The file is a test fixture");
    expect(items[0]).toHaveTextContent(/Asked by Grace Hopper, Nov 24, 2026/);
    expect(items[0]).not.toHaveTextContent(/until|reopens on/i);
    expect(items[1]).toHaveTextContent("Accept, reopens on Jan 15, 2027");
    expect(items[1]).toHaveTextContent("Fixed next sprint");
    expect(items[1]).toHaveTextContent("Asked by ada@acme.test");
    expect(items[2]).toHaveTextContent("Asked by an agent");
    expect(items[3]).toHaveTextContent("Asked by user_gone");
  });

  it("says a stale one's Finding has changed since it was asked, and not a fresh one's", () => {
    const { card } = show(
      finding(ID),
      listed([proposal({ id: "p-stale", stale: true }), proposal({ id: "p-fresh" })]),
    );
    const [stale, fresh] = proposalItems(card);
    expect(stale).toHaveTextContent("The Finding has changed since this was asked.");
    expect(fresh).not.toHaveTextContent("The Finding has changed since this was asked.");
  });

  it("shows no Proposals section when the focused Finding has none pending", () => {
    const { card } = show(finding(ID), listed([proposal({ finding_id: OTHER })]));
    expect(card.queryByRole("list", { name: "Pending Proposals" })).not.toBeInTheDocument();
    expect(card.queryByText("Pending Proposals")).not.toBeInTheDocument();
    expect(card.queryByText("Couldn't load Proposals")).not.toBeInTheDocument();
  });

  it.each<[string, ProposalsResult]>([
    ["not answering", { kind: "not-answering" }],
    ["no Team (403)", { kind: "no-team" }],
    ["a Team not opened (409)", { kind: "team-not-opened" }],
    ["too many attempts", { kind: "too-many-attempts", retryAfter: 12 }],
  ])("says Couldn't load Proposals when %s, and keeps the Finding's fields", (_why, result) => {
    const { card } = show(finding(ID), result);
    expect(card.getByText("Couldn't load Proposals")).toBeInTheDocument();
    expect(card.getByRole("heading", { name: "The agent can read .env files" })).toBeVisible();
    expect(fields(card).Evidence).toBe("permissions.allow lets the agent read .env");
  });

  it("offers Retry after Couldn't load Proposals", async () => {
    const { card, onRetry } = show(finding(ID), { kind: "not-answering" });
    await userEvent.click(card.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows neither the list nor the failure while the Proposals load", () => {
    const { card } = show(finding(ID), "loading");
    expect(card.queryByRole("list", { name: "Pending Proposals" })).not.toBeInTheDocument();
    expect(card.queryByText("Couldn't load Proposals")).not.toBeInTheDocument();
  });
});

describe("a Reopens on day sent as its start, as the server answers it", () => {
  it("the detail card's Reopens on and an accept Proposal's reopens on show the picked day", () => {
    // The start of Jan 15, 2027 in the person's time zone, in UTC as the server answers a date-time.
    const stored = new Date(2027, 0, 15).toISOString();
    const { card } = show(
      finding(ID, {
        status: "accepted",
        accepted_reason: "Fixed next sprint",
        accepted_until: stored,
      }),
      listed([proposal({ decision: "accept", until: stored })]),
    );

    expect(fields(card)["Reopens on"]).toBe("Jan 15, 2027");
    expect(proposalItems(card)[0]).toHaveTextContent("Accept, reopens on Jan 15, 2027");
  });
});

const SECOND = "b2b2b2b2-0000-4000-8000-000000000003";
const OPEN = finding(ID);
const ACCEPTED = finding(ID, {
  status: "accepted",
  accepted_reason: "Fixed next sprint",
  accepted_until: localAt("2027-02-22T12:00"),
});
const FALSE_POSITIVE = finding(ID, { status: "false_positive" });
const UNCONFIRMED = finding(ID, { status: "fixed", unconfirmed_fix: { candidates: [OTHER] } });
const FIXED = finding(ID, { status: "fixed" });
const MERGED = finding(ID, { status: "fixed", moved_to: OTHER });
/** The new Finding an Unconfirmed fix names, as the page's list holds it. */
const CANDIDATE = finding(OTHER, {
  title: "The agent can read .env.local",
  location: { kind: "file", path: ".env.local", line: 2 },
});

/** A day ten days ahead, as a date input holds it. */
const DAY = earliestUntil(new Date(Date.now() + 9 * 86_400_000));

/** The names of the buttons in the card's row of decisions (or Proposals), in order; none without a row. */
const rowButtons = (card: Card) => {
  const row = card.queryByRole("group", { name: "Decisions" });
  return row === null
    ? []
    : within(row)
        .getAllByRole("button")
        .map((b) => b.textContent);
};

const formNamed = (card: Card, name: string) => within(card.getByRole("form", { name }));
type Form = ReturnType<typeof formNamed>;

/** Presses the button `name` and returns the form it opens, named for it. */
async function openForm(card: Card, name: string): Promise<Form> {
  await userEvent.click(card.getByRole("button", { name }));
  return formNamed(card, name);
}

/** A Member's line in place of the Propose buttons while the focused Finding has a pending Proposal. */
const WAITING = "Waiting for a Lead or Admin to decide.";

const WHY = "Why accept this risk?";
const REOPENS_ON = "Reopens on";
const REOPENS_HINT = "Warden reopens it on this date so the Team looks again.";

const reasonField = (form: Form) => form.getByRole("textbox", { name: "Reason" });
/** An accept form's reason: it asks why the risk is accepted. */
const whyField = (form: Form) => form.getByRole("textbox", { name: WHY });
const pickUntil = (form: Form, day: string) =>
  fireEvent.change(form.getByLabelText(REOPENS_ON), { target: { value: day } });

/**
 * Fills each field the form has: the reason (or an accept's why) in place of any prefill, Reopens on (DAY), and the
 * first candidate.
 */
async function fill(form: Form, reason = "Checked by hand") {
  const reasonBox = form.queryByRole("textbox", { name: "Reason" }) ?? whyField(form);
  await userEvent.clear(reasonBox);
  await userEvent.type(reasonBox, reason);
  if (form.queryByLabelText(REOPENS_ON) !== null) pickUntil(form, DAY);
  const [candidate] = form.queryAllByRole("radio");
  if (candidate !== undefined) await userEvent.click(candidate);
}

/** The bodies sent to `path`, parsed; undefined for a request with none. */
const sent = (path: string) =>
  callsTo(path).map(([, init]) =>
    init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
  );

/** A Proposal as its routes answer it: no `stale`, which only the pending list adds. */
const answeredProposal = (fields: Partial<Proposal> = {}): Proposal => {
  const answer: Partial<PendingProposal> = { ...proposal(), ...fields };
  delete answer.stale;
  return answer as Proposal;
};

/** The first instant of `day` (a date input's value) in the person's own time zone, as epoch milliseconds. */
const dayStart = (day: string) => new Date(`${day}T00:00`).getTime();

/** `day` (a date input's value) as the card says a date: "Jan 15, 2027" (in an English locale). */
const dayShown = (day: string) => dayWords(`${day}T12:00`);

describe("each form's words", () => {
  /** The opened form's element, for what the queries can't name: its date input. */
  const formElement = (card: Card, name: string) => card.getByRole("form", { name });

  it.each<[string, Finding, Role]>([
    ["Accept", OPEN, "lead"],
    ["Renew acceptance", ACCEPTED, "lead"],
    ["Propose accepting", OPEN, "member"],
  ])(
    "%s asks why the risk is accepted, and the day it reopens on, with a hint read with the date",
    async (button, focused, role) => {
      const { card } = show(focused, listed([]), { role });
      const form = await openForm(card, button);

      expect(whyField(form)).toBeInTheDocument();
      expect(form.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
      const date = form.getByLabelText(REOPENS_ON);
      expect(date).toHaveAttribute("type", "date");
      expect(date).toHaveAccessibleName(REOPENS_ON);
      expect(date).toHaveAccessibleDescription(REOPENS_HINT);
      expect(form.queryByLabelText("Until")).not.toBeInTheDocument();
    },
  );

  it.each<[string, Finding, Role, PendingProposal[]]>([
    ["Mark False positive", OPEN, "lead", []],
    ["Confirm fix", UNCONFIRMED, "lead", []],
    ["Mark moved", UNCONFIRMED, "lead", []],
    ["Reopen", FALSE_POSITIVE, "lead", []],
    ["Propose False positive", OPEN, "member", []],
    ["Reject", OPEN, "lead", [proposal()]],
  ])("%s keeps Reason, and asks no date", async (button, focused, role, pending) => {
    const { card } = show(focused, listed(pending), { role, candidates: [CANDIDATE] });
    const form = await openForm(card, button);

    expect(reasonField(form)).toBeInTheDocument();
    expect(form.queryByText(WHY)).not.toBeInTheDocument();
    expect(form.queryByText(REOPENS_HINT)).not.toBeInTheDocument();
    expect(formElement(card, button).querySelector('input[type="date"]')).toBeNull();
  });
});

describe("a Lead's decision buttons", () => {
  it.each<[string, Finding, string[]]>([
    ["Open", OPEN, ["Accept", "Mark False positive"]],
    ["Accepted", ACCEPTED, ["Renew acceptance", "Mark False positive", "Reopen"]],
    ["False positive", FALSE_POSITIVE, ["Reopen"]],
    ["Fixed with an Unconfirmed fix", UNCONFIRMED, ["Confirm fix", "Mark moved"]],
    ["Fixed without one", FIXED, []],
    ["merged into another Finding", MERGED, []],
  ])("on a Finding that is %s", (_status, focused, buttons) => {
    const { card } = show(focused, listed([]), { role: "lead" });
    expect(rowButtons(card)).toEqual(buttons);
  });
});

describe("who sees which buttons", () => {
  const fresh = proposal({ id: "p-fresh" });
  const stale = proposal({ id: "p-stale", stale: true });

  it("a Member sees no decision button, and no Approve or Reject on a fresh or a stale Proposal", () => {
    const { card } = show(OPEN, listed([fresh, stale]), { role: "member" });
    expect(proposalItems(card)).toHaveLength(2);
    for (const name of ["Accept", "Mark False positive", "Approve", "Reject"]) {
      expect(card.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("a person whose Role hasn't loaded sees no decision button and no Propose button", () => {
    const { card } = show(OPEN, listed([fresh]), { role: null });
    expect(rowButtons(card)).toEqual([]);
    expect(card.queryByRole("button", { name: /^(Approve|Reject)$/ })).not.toBeInTheDocument();
  });
});

describe("a Member's Propose buttons", () => {
  it.each<[string, Finding, string[]]>([
    ["Open", OPEN, ["Propose accepting", "Propose False positive"]],
    ["Accepted", ACCEPTED, ["Propose accepting", "Propose False positive"]],
    ["False positive", FALSE_POSITIVE, []],
    ["Fixed with an Unconfirmed fix", UNCONFIRMED, []],
    ["merged into another Finding", MERGED, []],
  ])("on a Finding that is %s", (_status, focused, buttons) => {
    const { card } = show(focused, listed([]), { role: "member" });
    expect(rowButtons(card)).toEqual(buttons);
  });

  it.each<Role>(["lead", "admin"])("aren't shown to a %s", (role) => {
    const { card } = show(OPEN, listed([]), { role });
    expect(card.queryByRole("button", { name: /^Propose/ })).not.toBeInTheDocument();
  });
});

describe("a Member's Propose buttons while a Proposal waits", () => {
  it("give way to the waiting line, in the Done line's box but not bold, while the focused Finding has a pending Proposal", () => {
    const { card } = show(OPEN, listed([proposal()]), { role: "member" });

    expect(rowButtons(card)).toEqual([]);
    expect(card.queryByRole("button", { name: /^Propose/ })).not.toBeInTheDocument();
    const line = card.getByText(WAITING);
    expect(line.tagName).toBe("P");
    expect(line).toHaveClass("card-line");
    expect(line).not.toHaveClass("refused");
    expect(line).not.toHaveAttribute("role");
    expect(line).not.toHaveAttribute("tabindex");
    expect(card.queryByRole("status")).not.toBeInTheDocument();
    expect(card.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("show, with no waiting line, when only another Finding has one pending", () => {
    const { card } = show(OPEN, listed([proposal({ finding_id: OTHER })]), { role: "member" });

    expect(rowButtons(card)).toEqual(["Propose accepting", "Propose False positive"]);
    expect(card.queryByText(WAITING)).not.toBeInTheDocument();
  });

  it("and the waiting line are both left out while the Proposals load", () => {
    const { card } = show(OPEN, "loading", { role: "member" });

    expect(rowButtons(card)).toEqual([]);
    expect(card.queryByText(WAITING)).not.toBeInTheDocument();
  });

  it("show when the Proposals couldn't load: the server's 409 is the backstop", () => {
    const { card } = show(OPEN, { kind: "not-answering" }, { role: "member" });

    expect(rowButtons(card)).toEqual(["Propose accepting", "Propose False positive"]);
    expect(card.queryByText(WAITING)).not.toBeInTheDocument();
  });

  it("leave an open Propose form, and its typed reason, as they are while the Proposals load again (a Retry)", async () => {
    const shown = show(OPEN, { kind: "not-answering" }, { role: "member" });
    const form = await openForm(shown.card, "Propose False positive");
    await fill(form, "A test fixture");

    shown.update(OPEN, "loading");
    expect(shown.card.getByRole("form", { name: "Propose False positive" })).toBeInTheDocument();
    expect(reasonField(form)).toHaveValue("A test fixture");

    shown.update(OPEN, listed([]));
    expect(reasonField(form)).toHaveValue("A test fixture");
  });

  it("aren't replaced on a Finding whose Status takes no Proposal: there are none to replace", () => {
    const { card } = show(FALSE_POSITIVE, listed([proposal({ stale: true })]), { role: "member" });

    expect(rowButtons(card)).toEqual([]);
    expect(card.queryByText(WAITING)).not.toBeInTheDocument();
  });

  it.each<Role>(["lead", "admin"])(
    "leave a %s's decision buttons as they are, with no waiting line",
    (role) => {
      const { card } = show(OPEN, listed([proposal()]), { role });

      expect(rowButtons(card)).toEqual(["Accept", "Mark False positive"]);
      expect(card.queryByText(WAITING)).not.toBeInTheDocument();
    },
  );
});

describe("a Member's Proposal", () => {
  const answer = () => json(201, answeredProposal({ requested_by: { kind: "person", id: ME } }));

  it("Propose accepting sends the reason and the Reopens on day as a ProposeBody accept, and needs both", async () => {
    serve({ findingAction: answer });
    const { card } = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(card, "Propose accepting");
    const submit = form.getByRole("button", { name: "Propose" });

    expect(submit).toBeDisabled();
    await userEvent.type(whyField(form), "Fixed next sprint");
    expect(submit).toBeDisabled();
    pickUntil(form, DAY);
    await userEvent.click(submit);

    await card.findByRole("status");
    const [body] = sent(`/api/findings/${ID}/proposals`);
    const proposed = ProposeBody.parse(body);
    expect(proposed).toEqual({
      decision: "accept",
      reason: "Fixed next sprint",
      until: expect.any(String),
    });
    expect(Date.parse((proposed as { until: string }).until)).toBe(dayStart(DAY));
  });

  it("Propose False positive sends the reason as a ProposeBody mark_false_positive, with no until, and needs a reason", async () => {
    serve({ findingAction: answer });
    const { card } = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(card, "Propose False positive");
    const submit = form.getByRole("button", { name: "Propose" });

    expect(form.queryByLabelText(REOPENS_ON)).not.toBeInTheDocument();
    expect(submit).toBeDisabled();
    await userEvent.type(reasonField(form), "A test fixture");
    await userEvent.click(submit);

    await card.findByRole("status");
    const [body] = sent(`/api/findings/${ID}/proposals`);
    expect(ProposeBody.parse(body)).toEqual({
      decision: "mark_false_positive",
      reason: "A test fixture",
    });
    expect(body).not.toHaveProperty("until");
  });

  it("after a 201, says it was sent, with focus, and asks the Proposals again but not the Finding", async () => {
    serve({ findingAction: answer });
    const shown = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(shown.card, "Propose False positive");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "Propose" }));

    const line = await shown.card.findByRole("status");
    expect(line).toHaveTextContent("Proposal sent. A Lead or an Admin decides.");
    expect(line).toHaveFocus();
    expect(shown.card.queryByRole("form")).not.toBeInTheDocument();
    expect(shown.onProposalsChanged).toHaveBeenCalledOnce();
    expect(shown.onFindingChanged).not.toHaveBeenCalled();
  });

  it("after a 201, the sent line shows alone: the waiting line comes back once the card is opened again", async () => {
    serve({ findingAction: answer });
    const shown = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(shown.card, "Propose accepting");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "Propose" }));
    await shown.card.findByRole("status");

    // The panel asks the Proposals again; the list that comes back holds the one just sent.
    const mine = listed([proposal({ requested_by: { kind: "person", id: ME } })]);
    shown.update(OPEN, mine);

    expect(shown.card.getByRole("status")).toHaveTextContent(
      "Proposal sent. A Lead or an Admin decides.",
    );
    expect(shown.card.queryByText(WAITING)).not.toBeInTheDocument();
    expect(shown.card.getAllByText(/./, { selector: ".card-line" })).toHaveLength(1);
    expect(rowButtons(shown.card)).toEqual([]);

    shown.unmount();
    const again = show(OPEN, mine, { role: "member" });

    expect(again.card.queryByRole("status")).not.toBeInTheDocument();
    expect(again.card.getByText(WAITING)).toBeInTheDocument();
  });

  it.each<[string, number, string, "refreshMe" | "onFindingChanged"]>([
    ["403", 403, "Warden refused this: your Team or Role may have changed.", "refreshMe"],
    [
      "409",
      409,
      "This Finding changed since you opened it. Look again before deciding.",
      "onFindingChanged",
    ],
  ])(
    "a %s shows its line, keeps the reason and runs what it says",
    async (_why, status, line, runs) => {
      // No `error` in the body: a 409 then falls back to the dashboard's own line.
      serve({ findingAction: () => json(status, {}) });
      const shown = show(OPEN, listed([]), { role: "member" });
      const form = await openForm(shown.card, "Propose False positive");
      await fill(form, "A test fixture");
      await userEvent.click(form.getByRole("button", { name: "Propose" }));

      expect(await form.findByRole("alert")).toHaveTextContent(line);
      expect(reasonField(form)).toHaveValue("A test fixture");
      expect(shown[runs]).toHaveBeenCalledOnce();
    },
  );

  it("a 409 whose body says why shows the server's words: a Team its Admin hasn't opened", async () => {
    serve({
      findingAction: () => json(409, { error: "Your Team's Admin must open Warden first" }),
    });
    const { card } = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(card, "Propose False positive");
    await fill(form, "A test fixture");
    await userEvent.click(form.getByRole("button", { name: "Propose" }));

    expect(await form.findByRole("alert")).toHaveTextContent(
      /^Your Team's Admin must open Warden first\.$/,
    );
    expect(reasonField(form)).toHaveValue("A test fixture");
  });

  it("a 409 because a Proposal is already pending shows the server's sentence and asks the Proposals again; the list that comes back puts the waiting line in the buttons' place", async () => {
    const sentence = "This Finding already has a Proposal waiting for a Lead or Admin to decide.";
    serve({ findingAction: () => json(409, { error: sentence }) });
    const shown = show(OPEN, listed([]), { role: "member" });
    const form = await openForm(shown.card, "Propose False positive");
    await fill(form, "A test fixture");
    await userEvent.click(form.getByRole("button", { name: "Propose" }));

    expect(await form.findByRole("alert")).toHaveTextContent(sentence);
    expect(shown.onProposalsChanged).toHaveBeenCalledOnce();

    shown.update(OPEN, listed([proposal({ requested_by: { kind: "agent", id: "guard-bot" } })]));

    expect(shown.card.queryByRole("form")).not.toBeInTheDocument();
    expect(shown.card.getByRole("alert")).toHaveTextContent(sentence);
    expect(shown.card.getByText(WAITING, { selector: "p:not([role])" })).toBeInTheDocument();
    expect(rowButtons(shown.card)).toEqual([]);
  });
});

describe("a Lead's decision", () => {
  it.each<[string, Finding]>([
    ["Accept", OPEN],
    ["Renew acceptance", ACCEPTED],
  ])(
    "%s sends the reason and an until at the start of the chosen day in the person's time zone; Reopens on's earliest day is tomorrow",
    async (button, focused) => {
      serve({ findingAction: () => json(200, ACCEPTED) });
      const { card } = show(focused, listed([]), { role: "lead" });
      const form = await openForm(card, button);
      expect(form.getByLabelText(REOPENS_ON)).toHaveAttribute("min", earliestUntil());

      await fill(form, "Fixed next sprint");
      await userEvent.click(form.getByRole("button", { name: button }));

      await card.findByRole("status");
      const [body] = sent(`/api/findings/${ID}/accept`);
      const accepted = AcceptBody.parse(body);
      expect(accepted.reason).toBe("Fixed next sprint");
      expect(Date.parse(accepted.until)).toBe(dayStart(DAY));
    },
  );

  it.each<[string, Finding, string]>([
    ["Mark False positive", OPEN, "false-positive"],
    ["Confirm fix", UNCONFIRMED, "confirm-fix"],
    ["Reopen", FALSE_POSITIVE, "reopen"],
  ])("%s sends its route with the reason and nothing else", async (button, focused, path) => {
    serve({ findingAction: () => json(200, focused) });
    const { card } = show(focused, listed([]), { role: "lead" });
    const form = await openForm(card, button);
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: button }));

    await card.findByRole("status");
    expect(sent(`/api/findings/${ID}/${path}`)).toEqual([{ reason: "Checked by hand" }]);
  });

  it("Mark moved lists each candidate with its short id, title and Location, and sends the one chosen", async () => {
    serve({ findingAction: () => json(200, OPEN) });
    const second = finding(SECOND, {
      title: "Another agent reads .env",
      location: { kind: "file", path: "apps/web/.claude/settings.json" },
    });
    const focused = finding(ID, {
      status: "fixed",
      unconfirmed_fix: { candidates: [OTHER, SECOND] },
    });
    const { card } = show(focused, listed([]), { role: "lead", candidates: [CANDIDATE, second] });
    const form = await openForm(card, "Mark moved");

    const radios = form.getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "a1c4e7f0 · The agent can read .env.local · .env.local:2",
      "b2b2b2b2 · Another agent reads .env · apps/web/.claude/settings.json",
    ]);
    await userEvent.type(reasonField(form), "The same rule moved");
    await userEvent.click(radios[1]!);
    await userEvent.click(form.getByRole("button", { name: "Mark moved" }));

    await card.findByRole("status");
    expect(sent(`/api/findings/${ID}/mark-moved`)).toEqual([
      { reason: "The same rule moved", candidate: SECOND },
    ]);
  });

  it("Mark moved offers only the candidates the server would merge: Open, not merged, same module, Rule and Asset", async () => {
    const id = (n: number) => `c${n}c${n}c${n}c${n}-0000-4000-8000-00000000000${n}`;
    const refused = [
      finding(id(1), { status: "fixed" }),
      finding(id(2), { status: "fixed", moved_to: ID }),
      finding(id(3), { rule_id: "guard/agent-can-push-main" }),
      finding(id(4), { asset: { kind: "repo", ref: "https://github.com/acme/other" } }),
      finding(id(5), { asset: { kind: "product", ref: "https://github.com/acme/shop-web" } }),
      finding(id(6), { module: "patch" }),
    ];
    const focused = finding(ID, {
      status: "fixed",
      unconfirmed_fix: { candidates: [OTHER, ...refused.map((f) => f.id)] },
    });
    const { card } = show(focused, listed([]), {
      role: "lead",
      candidates: [...refused, CANDIDATE],
    });
    const form = await openForm(card, "Mark moved");

    expect(form.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual([OTHER]);
  });

  it("Mark moved with none of its candidates mergeable says so and can't be sent", async () => {
    const focused = finding(ID, { status: "fixed", unconfirmed_fix: { candidates: [SECOND] } });
    const { card } = show(focused, listed([]), {
      role: "lead",
      candidates: [finding(SECOND, { status: "fixed" })],
    });
    const form = await openForm(card, "Mark moved");

    expect(form.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      form.getByText("The candidate isn't in this view's list. Reload to see it."),
    ).toBeInTheDocument();
  });

  it("Mark moved with no candidate in the list says so and can't be sent", async () => {
    const { card } = show(UNCONFIRMED, listed([]), { role: "lead", candidates: [] });
    const form = await openForm(card, "Mark moved");

    expect(
      form.getByText("The candidate isn't in this view's list. Reload to see it."),
    ).toBeInTheDocument();
    await userEvent.type(reasonField(form), "It moved");
    expect(form.getByRole("button", { name: "Mark moved" })).toBeDisabled();
  });

  it("the submit is disabled for a blank or whitespace reason and an empty Reopens on; the reason takes at most 2,000 characters", async () => {
    const { card } = show(OPEN, listed([]), { role: "lead" });
    const form = await openForm(card, "Accept");
    const submit = form.getByRole("button", { name: "Accept" });
    expect(whyField(form)).toHaveAttribute("maxlength", "2000");

    pickUntil(form, DAY);
    expect(submit).toBeDisabled();
    await userEvent.type(whyField(form), "   ");
    expect(submit).toBeDisabled();
    await userEvent.type(whyField(form), "Fixed next sprint");
    expect(submit).toBeEnabled();
    pickUntil(form, "");
    expect(submit).toBeDisabled();
  });

  it("Mark moved's submit is disabled until a candidate is chosen", async () => {
    const { card } = show(UNCONFIRMED, listed([]), { role: "lead", candidates: [CANDIDATE] });
    const form = await openForm(card, "Mark moved");
    await userEvent.type(reasonField(form), "It moved");
    const submit = form.getByRole("button", { name: "Mark moved" });

    expect(submit).toBeDisabled();
    await userEvent.click(form.getByRole("radio"));
    expect(submit).toBeEnabled();
  });

  it("while the call runs, its submit is busy and disabled, and a second click sends nothing", async () => {
    const answer = deferred<Response>();
    serve({ findingAction: () => answer.promise });
    const { card } = show(OPEN, listed([]), { role: "lead" });
    const form = await openForm(card, "Mark False positive");
    await fill(form);
    const submit = form.getByRole("button", { name: "Mark False positive" });

    await userEvent.click(submit);
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    expect(callsTo(`/api/findings/${ID}/false-positive`)).toHaveLength(1);

    answer.resolve(json(200, FALSE_POSITIVE));
    expect(await card.findByRole("status")).toHaveTextContent("Marked a False positive.");
  });

  it("Cancel closes the form, sends nothing, and puts focus back on the button that opened it", async () => {
    serve({});
    const { card } = show(ACCEPTED, listed([]), { role: "lead" });
    const form = await openForm(card, "Reopen");
    await userEvent.type(reasonField(form), "Changed my mind");

    await userEvent.click(form.getByRole("button", { name: "Cancel" }));

    expect(card.queryByRole("form")).not.toBeInTheDocument();
    expect(card.getByRole("button", { name: "Reopen" })).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, Finding, string]>([
    ["Accept", OPEN, `Accepted. Reopens on ${dayShown(DAY)}.`],
    ["Renew acceptance", ACCEPTED, `Accepted. Reopens on ${dayShown(DAY)}.`],
    ["Mark False positive", OPEN, "Marked a False positive."],
    ["Confirm fix", UNCONFIRMED, "Fix confirmed."],
    ["Mark moved", UNCONFIRMED, "Marked moved: a1c4e7f0 merged into this Finding."],
    ["Reopen", FALSE_POSITIVE, "Reopened."],
  ])(
    "after a 200, %s shows its done line with focus, and asks the Finding and the Proposals again once each",
    async (button, focused, line) => {
      serve({ findingAction: () => json(200, focused) });
      const shown = show(focused, listed([]), { role: "lead", candidates: [CANDIDATE] });
      const form = await openForm(shown.card, button);
      await fill(form);
      await userEvent.click(form.getByRole("button", { name: button }));

      const done = await shown.card.findByRole("status");
      expect(done).toHaveTextContent(line);
      expect(done).toHaveFocus();
      expect(shown.card.queryByRole("form")).not.toBeInTheDocument();
      expect(shown.onFindingChanged).toHaveBeenCalledOnce();
      expect(shown.onProposalsChanged).toHaveBeenCalledOnce();
    },
  );

  it.each<
    [string, () => Response, string, "refreshMe" | "onFindingChanged" | "onFindingGone" | null]
  >([
    [
      "400",
      () => json(400, { error: "reason: Too big: expected string to have <=2000 characters" }),
      "Warden refused this: reason: Too big: expected string to have <=2000 characters.",
      null,
    ],
    [
      "403",
      () => json(403, { error: "Your Role can't do this" }),
      "Only a Lead or an Admin can decide this. Your Role may have changed.",
      "refreshMe",
    ],
    [
      "404",
      () => json(404, { error: "No such Finding" }),
      "This Finding is no longer in your Team.",
      "onFindingGone",
    ],
    [
      "409 with no reason in its body",
      () => json(409, {}),
      "This Finding changed since you opened it. Look again before deciding.",
      "onFindingChanged",
    ],
    [
      "409 with the server's reason",
      () => json(409, { error: "This Finding is a False positive already." }),
      "This Finding is a False positive already.",
      "onFindingChanged",
    ],
    [
      "not answering",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "Warden's server isn't answering. Your reason is kept: try again.",
      null,
    ],
    [
      "too many attempts",
      () => json(429, { error: "Too many" }, { "Retry-After": "12" }),
      "Too many sign-in attempts. Try again in 12 seconds.",
      null,
    ],
  ])(
    "a %s shows its line, keeps the reason, and runs what it says",
    async (_why, answer, line, runs) => {
      serve({ findingAction: answer });
      const shown = show(OPEN, listed([]), { role: "lead" });
      const form = await openForm(shown.card, "Mark False positive");
      await fill(form, "A test fixture");
      await userEvent.click(form.getByRole("button", { name: "Mark False positive" }));

      expect(await form.findByRole("alert")).toHaveTextContent(line);
      expect(reasonField(form)).toHaveValue("A test fixture");
      for (const call of ["refreshMe", "onFindingChanged", "onFindingGone"] as const) {
        expect(shown[call]).toHaveBeenCalledTimes(call === runs ? 1 : 0);
      }
    },
  );

  it("a 409 after which the Finding's new Status no longer offers the decision closes the form, shows the new Status's row, and moves focus to the line", async () => {
    serve({ findingAction: () => json(409, {}) });
    const { card, update } = show(OPEN, listed([]), { role: "lead" });
    const form = await openForm(card, "Accept");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "Accept" }));
    await form.findByRole("alert");

    update(FALSE_POSITIVE);

    expect(card.queryByRole("form")).not.toBeInTheDocument();
    expect(rowButtons(card)).toEqual(["Reopen"]);
    const line = card.getByRole("alert");
    expect(line).toHaveTextContent(
      "This Finding changed since you opened it. Look again before deciding.",
    );
    expect(line).toHaveFocus();
  });

  it("a form that closes because its Proposal left the list, with no line, moves focus to the first button left", async () => {
    const { card, update } = show(OPEN, listed([proposal({ id: "p-gone" })]), { role: "lead" });
    const form = await openForm(card, "Reject");
    await userEvent.type(reasonField(form), "Half typed");

    update(OPEN, listed([]));

    expect(card.queryByRole("form")).not.toBeInTheDocument();
    expect(card.getByRole("button", { name: "Accept" })).toHaveFocus();
  });

  it("a session-ended answer signs the person out", async () => {
    serve({ findingAction: () => json(401, { error: "Not signed in" }) });
    const shown = show(OPEN, listed([]), { role: "lead" });
    const form = await openForm(shown.card, "Mark False positive");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "Mark False positive" }));

    await vi.waitFor(() => expect(shown.onSessionEnded).toHaveBeenCalledOnce());
  });
});

// One branch for both: a day midnight has made today, and a day before tomorrow typed into the date field.
describe("a Reopens on day before tomorrow, typed in or made today by midnight", () => {
  afterEach(() => vi.useRealTimers());

  /**
   * Opens `button`'s form at 23:58, types a reason and picks the next day; at 00:01 types one more character, which
   * redraws the form: the day it picked is now today.
   */
  async function editPastMidnight(shown: Finding, button: string, role: Role, submitName: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 25, 23, 58));
    // As the server refuses an until that isn't later than now: the words the form must not show.
    serve({ findingAction: () => json(400, { error: "until: until must be later than now" }) });
    const { card } = show(shown, listed([]), { role });
    const form = await openForm(card, button);
    await userEvent.clear(whyField(form));
    await userEvent.type(whyField(form), "Fixed next sprint");
    pickUntil(form, "2026-11-26");

    vi.setSystemTime(new Date(2026, 10, 26, 0, 1));
    await userEvent.type(whyField(form), ".");
    return { form, submit: form.getByRole("button", { name: submitName }) };
  }

  it.each<[string, Finding, Role, string]>([
    ["Accept", OPEN, "lead", "Accept"],
    ["Renew acceptance", ACCEPTED, "lead", "Renew acceptance"],
    ["Propose accepting", OPEN, "member", "Propose"],
  ])(
    "%s keeps its submit on, then refuses in the form's own words, keeps the reason, and sends nothing",
    async (button, shown, role, submitName) => {
      const { form, submit } = await editPastMidnight(shown, button, role, submitName);

      expect(submit).toBeEnabled();
      await userEvent.click(submit);

      const refusal = await form.findByRole("alert");
      expect(refusal).toHaveTextContent(
        /^Reopens on must be a later day\. Pick tomorrow or later\.$/,
      );
      expect(refusal).not.toHaveTextContent(/until/i);
      expect(whyField(form)).toHaveValue("Fixed next sprint.");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("after that refusal, Reopens on's earliest day is the day after the new today", async () => {
    const { form, submit } = await editPastMidnight(OPEN, "Accept", "lead", "Accept");
    await userEvent.click(submit);

    await form.findByRole("alert");
    expect(form.getByLabelText(REOPENS_ON)).toHaveAttribute("min", "2026-11-27");
  });
});

describe("the reason an accept form opens with", () => {
  it("Renew acceptance opens with the current acceptance reason, editable, and no Reopens on: its submit waits for a day", async () => {
    const { card } = show(ACCEPTED, listed([]), { role: "lead" });
    const form = await openForm(card, "Renew acceptance");
    const submit = form.getByRole("button", { name: "Renew acceptance" });

    expect(whyField(form)).toHaveValue("Fixed next sprint");
    expect(form.getByLabelText(REOPENS_ON)).toHaveValue("");
    expect(submit).toBeDisabled();
    await userEvent.type(whyField(form), ", then the one after");
    expect(whyField(form)).toHaveValue("Fixed next sprint, then the one after");
    pickUntil(form, DAY);
    expect(submit).toBeEnabled();
  });

  it("Renew acceptance opens with the current reason again after a Cancel, not what was typed before it", async () => {
    const { card } = show(ACCEPTED, listed([]), { role: "lead" });
    const first = await openForm(card, "Renew acceptance");
    await userEvent.type(whyField(first), " and more");
    await userEvent.click(first.getByRole("button", { name: "Cancel" }));

    const again = await openForm(card, "Renew acceptance");
    expect(whyField(again)).toHaveValue("Fixed next sprint");
  });

  it.each<[string, string, Finding, Role]>([
    ["Accept", "an Open", OPEN, "lead"],
    ["Propose accepting", "an Accepted", ACCEPTED, "member"],
  ])("%s on %s Finding opens with an empty reason", async (button, _status, focused, role) => {
    const { card } = show(focused, listed([]), { role });
    const form = await openForm(card, button);
    expect(whyField(form)).toHaveValue("");
  });

  it("after a refusal, Renew acceptance keeps what the person typed, not the prefill, even as the Finding comes back changed", async () => {
    serve({ findingAction: () => json(409, {}) });
    const { card, update } = show(ACCEPTED, listed([]), { role: "lead" });
    const form = await openForm(card, "Renew acceptance");
    await fill(form, "Waiting on the vendor's patch");
    await userEvent.click(form.getByRole("button", { name: "Renew acceptance" }));
    await form.findByRole("alert");

    update({ ...ACCEPTED, accepted_reason: "Someone else's reason" });

    const kept = formNamed(card, "Renew acceptance");
    expect(kept.getByRole("alert")).toBeInTheDocument();
    expect(whyField(kept)).toHaveValue("Waiting on the vendor's patch");
  });
});

describe("a Lead's Approve and Reject", () => {
  const fresh = proposal({ id: "p-fresh" });
  const stale = proposal({ id: "p-stale", stale: true, reason: "Asked before a Scan" });
  const decided: Routes["proposalAction"] = (id, action, body) =>
    json(
      200,
      answeredProposal({
        id,
        state: action === "approve" ? "approved" : "rejected",
        decided_by: ME,
        decided_at: "2026-11-25T09:00:00Z",
        decided_reason: action === "reject" ? (body as { reason: string }).reason : null,
      }),
    );
  const buttonsOf = (item: HTMLElement) =>
    within(item)
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("a fresh Proposal offers Approve and Reject; a stale one only Reject", () => {
    const { card } = show(OPEN, listed([fresh, stale]), { role: "lead" });
    const [freshItem, staleItem] = proposalItems(card);
    expect(buttonsOf(freshItem!)).toEqual(["Approve", "Reject"]);
    expect(buttonsOf(staleItem!)).toEqual(["Reject"]);
  });

  it("Approve sends its route with no body; Reject sends the reason, and can't be sent blank", async () => {
    serve({ proposalAction: decided });
    const { card } = show(OPEN, listed([fresh, stale]), { role: "lead" });

    await userEvent.click(within(proposalItems(card)[0]!).getByRole("button", { name: "Approve" }));
    await card.findByRole("status");
    expect(callsTo("/api/proposals/p-fresh/approve")).toEqual([
      [
        "/api/proposals/p-fresh/approve",
        { method: "POST", headers: { Authorization: "Bearer session-token" } },
      ],
    ]);

    await userEvent.click(within(proposalItems(card)[1]!).getByRole("button", { name: "Reject" }));
    const form = formNamed(card, "Reject");
    const submit = form.getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();
    await userEvent.type(reasonField(form), "  ");
    expect(submit).toBeDisabled();
    await userEvent.type(reasonField(form), "Still in the build");
    await userEvent.click(submit);

    await vi.waitFor(() =>
      expect(sent("/api/proposals/p-stale/reject")).toEqual([{ reason: "Still in the build" }]),
    );
  });

  it("after an approve, says so with focus, asks the Proposals again and the Finding", async () => {
    serve({ proposalAction: decided });
    const shown = show(OPEN, listed([fresh]), { role: "lead" });
    await userEvent.click(shown.card.getByRole("button", { name: "Approve" }));

    const line = await shown.card.findByRole("status");
    expect(line).toHaveTextContent("Proposal approved.");
    expect(line).toHaveFocus();
    expect(shown.onProposalsChanged).toHaveBeenCalledOnce();
    expect(shown.onFindingChanged).toHaveBeenCalledOnce();
  });

  it("after a reject, says so with focus and asks the Proposals again", async () => {
    serve({ proposalAction: decided });
    const shown = show(OPEN, listed([fresh]), { role: "lead" });
    const form = await openForm(shown.card, "Reject");
    await fill(form, "Still in the build");
    await userEvent.click(form.getByRole("button", { name: "Reject" }));

    const line = await shown.card.findByRole("status");
    expect(line).toHaveTextContent("Proposal rejected.");
    expect(line).toHaveFocus();
    expect(shown.onProposalsChanged).toHaveBeenCalledOnce();
  });

  it.each<[string, "Approve" | "Reject", number, string]>([
    [
      "a 409 on approve",
      "Approve",
      409,
      "This Proposal was decided already, or its Finding changed. The list is refreshed.",
    ],
    [
      "a 409 on reject",
      "Reject",
      409,
      "This Proposal was decided already, or its Finding changed. The list is refreshed.",
    ],
    ["a 404 on approve", "Approve", 404, "This Proposal is no longer in your Team."],
    ["a 404 on reject", "Reject", 404, "This Proposal is no longer in your Team."],
  ])("%s shows its line and asks the Proposals again", async (_why, button, status, line) => {
    // No `error` in the body: a 409 then falls back to the dashboard's own line.
    serve({ proposalAction: () => json(status, {}) });
    const shown = show(OPEN, listed([fresh]), { role: "lead" });
    if (button === "Approve") {
      await userEvent.click(shown.card.getByRole("button", { name: "Approve" }));
    } else {
      const form = await openForm(shown.card, "Reject");
      await fill(form);
      await userEvent.click(form.getByRole("button", { name: "Reject" }));
    }

    expect(await shown.card.findByRole("alert")).toHaveTextContent(line);
    expect(shown.onProposalsChanged).toHaveBeenCalledOnce();
  });

  it("a 409 on approve whose body says why shows the server's words: the Finding changed since it was asked", async () => {
    const why =
      "This Finding changed after the Proposal was asked, so the Proposal can't be approved: ask again.";
    serve({ proposalAction: () => json(409, { error: why }) });
    const { card } = show(OPEN, listed([fresh]), { role: "lead" });
    await userEvent.click(card.getByRole("button", { name: "Approve" }));

    expect(await card.findByRole("alert")).toHaveTextContent(why);
  });

  it("a finished call closes only its own form: an Approve on B leaves the Reject form on A and its text", async () => {
    const answer = deferred<Response>();
    serve({ proposalAction: () => answer.promise });
    const a = proposal({ id: "p-a", reason: "A's reason" });
    const b = proposal({ id: "p-b", reason: "B's reason" });
    const { card } = show(OPEN, listed([a, b]), { role: "lead" });
    const [itemA, itemB] = proposalItems(card);
    await userEvent.click(within(itemA!).getByRole("button", { name: "Reject" }));
    await userEvent.type(reasonField(formNamed(card, "Reject")), "Half typed");

    await userEvent.click(within(itemB!).getByRole("button", { name: "Approve" }));
    // While it runs, every other opener and Approve or Reject waits.
    for (const name of ["Accept", "Mark False positive", "Reject"]) {
      for (const button of card.getAllByRole("button", { name })) {
        if (button.closest("form") === null) expect(button).toBeDisabled();
      }
    }
    answer.resolve((await decided!("p-b", "approve", undefined)) as Response);

    expect(await card.findByRole("status")).toHaveTextContent("Proposal approved.");
    expect(reasonField(formNamed(card, "Reject"))).toHaveValue("Half typed");
  });
});
