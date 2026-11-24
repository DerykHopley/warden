// The detail card (story 9, story 3): the focused Finding's fields in the dashboard's words, then its pending
// Proposals, read-only. It renders DetailCard alone; how the panel asks for the Proposals is in AskWardenPanel.test.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, Location, PendingProposal } from "@warden/contracts";
import { describe, expect, it, vi } from "vitest";
import { DetailCard } from "../src/DetailCard.tsx";
import type { ProposalsResult } from "../src/proposals.ts";
import { finding, TEAM } from "./findings-fixture.ts";

const ID = "3f9a1c2e-0000-4000-8000-000000000001";
const OTHER = "a1c4e7f0-0000-4000-8000-000000000002";

const proposal = (fields: Partial<PendingProposal> = {}): PendingProposal => ({
  id: "p-1",
  finding_id: ID,
  decision: "mark_false_positive",
  reason: "The file is a test fixture",
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

const listed = (proposals: PendingProposal[]): ProposalsResult => ({
  kind: "proposals",
  team: TEAM,
  proposals,
});

const clerkUsers = new Map([
  ["user_grace", { firstName: "Grace", lastName: "Hopper", identifier: "grace@acme.test" }],
  ["user_ada", { firstName: null, lastName: null, identifier: "ada@acme.test" }],
]);

function show(
  focused: Finding,
  proposals: ProposalsResult | "loading" = listed([]),
  onClear = vi.fn(),
) {
  render(
    <DetailCard
      finding={focused}
      proposals={proposals}
      clerkUsers={clerkUsers}
      onClear={onClear}
    />,
  );
  return { card: within(screen.getByRole("region", { name: focused.title })), onClear };
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

  it("shows an Accepted Finding's reason and until date", () => {
    const { card } = show(
      finding(ID, {
        status: "accepted",
        accepted_reason: "Fixed next sprint",
        accepted_until: "2027-02-22T12:00:00Z",
      }),
    );
    expect(card.getByText("Accepted")).toBeInTheDocument();
    expect(fields(card)).toMatchObject({
      "Accepted because": "Fixed next sprint",
      Until: "Feb 22, 2027",
    });
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

describe("the detail card's pending Proposals", () => {
  const proposalItems = (card: ReturnType<typeof show>["card"]) =>
    within(card.getByRole("list", { name: "Pending Proposals" })).getAllByRole("listitem");

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
          until: "2027-01-15T12:00:00Z",
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
    expect(items[0]).not.toHaveTextContent("until");
    expect(items[1]).toHaveTextContent("Accept until Jan 15, 2027");
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

  it("shows neither the list nor the failure while the Proposals load", () => {
    const { card } = show(finding(ID), "loading");
    expect(card.queryByRole("list", { name: "Pending Proposals" })).not.toBeInTheDocument();
    expect(card.queryByText("Couldn't load Proposals")).not.toBeInTheDocument();
  });
});
