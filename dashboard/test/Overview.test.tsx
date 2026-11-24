// The Overview page (story 10): the journey cards with their states in words and their bars, the trend line, the audit
// section, and each answer GET /api/overview can get. It renders OverviewPage alone with spy props, Warden's server
// faked. Which card is in which state, and the trend's wordings, are tested below the page, in overview.test.ts.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OverviewBody } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "../src/Overview.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const SCANNED = "2026-11-24T09:14:00Z";
const scannedOn = new Date(SCANNED).toLocaleDateString(undefined, { dateStyle: "medium" });

/** The demo seed's overview: everything opened during the period, one of eleven fixed. */
const overview = (fields: Partial<OverviewBody> = {}): OverviewBody => ({
  team: TEAM,
  level: "quick",
  last_scan_at: SCANNED,
  period_days: 30,
  open_at_start: 0,
  open_now: 7,
  fix_rate: { fixed: 1, of: 11 },
  ...fields,
});

const answer = (fields: Partial<OverviewBody> = {}) => json(200, overview(fields));

/** Renders OverviewPage with GET /api/overview answering `fields` unless `routes` says otherwise. */
function open(fields: Partial<OverviewBody> = {}, routes: Routes = {}) {
  window.history.replaceState(null, "", "/overview");
  serve({ overview: () => answer(fields), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_ada", team: TEAM, role: "admin" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
  render(<OverviewPage {...props} />);
  return props;
}

const journey = () => screen.getByRole("list", { name: "The journey" });
const cardOf = (word: string) => {
  const card = within(journey())
    .getAllByRole("listitem")
    .find((li) => within(li).queryByText(word, { selector: ".journey-level" }) !== null);
  if (card === undefined) throw new Error(`no journey card for ${word}`);
  return within(card);
};

describe("the journey", () => {
  it("shows Quick, Standard and Audit-ready in order, each with what it adds", async () => {
    open();
    await screen.findByRole("list", { name: "The journey" });
    expect(
      within(journey())
        .getAllByRole("listitem")
        .map((li) => [
          li.querySelector(".journey-level")?.textContent,
          li.querySelector(".journey-adds")?.textContent,
        ]),
    ).toEqual([
      ["Quick", "Repo scan and top fixes"],
      ["Standard", "Agent hook and the Judge"],
      ["Audit-ready", "Evidence for an audit"],
    ]);
  });

  it("at Quick after a Scan: Quick reads Current with a full bar, the Scan's date and the next step", async () => {
    open();
    await screen.findByRole("list", { name: "The journey" });
    const quick = cardOf("Quick");
    expect(quick.getByText("Current")).toBeInTheDocument();
    expect(quick.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(quick.getByText(`Last Scan: ${scannedOn}`)).toBeInTheDocument();
    expect(quick.getByText("Next: Standard adds the agent hook and the Judge")).toBeInTheDocument();
    for (const word of ["Standard", "Audit-ready"]) {
      expect(cardOf(word).getByText("Not started")).toBeInTheDocument();
      expect(cardOf(word).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    }
  });

  it("before the first Scan: Quick's bar is empty and its next step is the first Scan", async () => {
    open({ last_scan_at: null, open_now: 0, fix_rate: { fixed: 0, of: 0 } });
    await screen.findByRole("list", { name: "The journey" });
    const quick = cardOf("Quick");
    expect(quick.getByText("Current")).toBeInTheDocument();
    expect(quick.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(quick.getByText("Next: the first Scan")).toBeInTheDocument();
    expect(quick.queryByText(/^Last Scan/)).not.toBeInTheDocument();
  });

  it("at Standard: Quick reads Done with a full bar, and Standard is the current card", async () => {
    open({ level: "standard" });
    await screen.findByRole("list", { name: "The journey" });
    expect(cardOf("Quick").getByText("Done")).toBeInTheDocument();
    expect(cardOf("Quick").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(cardOf("Standard").getByText("Current")).toBeInTheDocument();
    expect(cardOf("Audit-ready").getByText("Not started")).toBeInTheDocument();
    const current = within(journey())
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "step");
    expect(current.map((li) => li.querySelector(".journey-level")?.textContent)).toEqual([
      "Standard",
    ]);
  });

  it("gives each bar a name and its range", async () => {
    open();
    await screen.findByRole("list", { name: "The journey" });
    const bar = cardOf("Quick").getByRole("progressbar", { name: "Quick" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
});

describe("the page", () => {
  it("opens with the heading Overview, then the trend line in the heading font", async () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(
      await screen.findByText("Open Findings went from 0 to 7 in 30 days; fix rate 9%."),
    ).toHaveClass("trend-line");
  });

  it("asks 'Are we ready for the audit?' with its one line and no rows", async () => {
    open();
    await screen.findByRole("list", { name: "The journey" });
    const audit = screen.getByRole("region", { name: "Are we ready for the audit?" });
    expect(within(audit).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Are we ready for the audit?",
    );
    expect(audit).toHaveTextContent(
      "Warden can answer this at Audit-ready, once Vouch checks your Controls.",
    );
    expect(within(audit).queryAllByRole("row")).toEqual([]);
    expect(within(audit).queryAllByRole("listitem")).toEqual([]);
  });
});

describe("waiting and refusals", () => {
  it("shows Loading Overview… until the answer arrives, asking with the session token", async () => {
    const late = deferred<Response>();
    open({}, { overview: () => late.promise });
    expect(screen.getByText("Loading Overview…")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "The journey" })).not.toBeInTheDocument();
    late.resolve(answer());
    expect(await screen.findByRole("list", { name: "The journey" })).toBeInTheDocument();
    expect(screen.queryByText("Loading Overview…")).not.toBeInTheDocument();
    expect(callsTo("/api/overview")[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("says the server isn't answering when it can't be reached, and Retry asks again", async () => {
    let answered = 0;
    open(
      {},
      {
        overview: () => {
          answered += 1;
          if (answered === 1) throw new TypeError("Failed to fetch");
          return answer();
        },
      },
    );
    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "The journey" })).toBeInTheDocument();
  });

  it("counts a body that doesn't parse as not answering", async () => {
    open({}, { overview: () => json(200, { ...overview(), level: "expert" }) });
    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
  });

  it("shows the too-many-attempts notice on a 429", async () => {
    open(
      {},
      {
        overview: () => json(429, { error: "Too many sign-in attempts" }, { "Retry-After": "12" }),
      },
    );
    expect(
      await screen.findByText("Too many sign-in attempts. Try again in 12 seconds."),
    ).toBeInTheDocument();
  });

  it("asks to choose a Team on a 403", async () => {
    open({}, { overview: () => json(403, { error: "Choose a Team first" }) });
    expect(
      await screen.findByText("Choose a Team first, from the switcher above."),
    ).toBeInTheDocument();
  });

  it("says the Team's Admin must open Warden first on a 409", async () => {
    open({}, { overview: () => json(409, { error: "Open it first" }) });
    expect(
      await screen.findByText(
        "Your Team's Admin must open Warden first. Try again once they have.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "The journey" })).not.toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    const props = open({}, { overview: () => json(401, { error: "Not signed in" }) });
    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalled());
  });

  it("asks again when the answer is about another Team, and never shows it", async () => {
    const answers = [answer({ team: "org_b", open_now: 99 }), answer()];
    open({}, { overview: () => answers.shift() ?? answer() });
    expect(
      await screen.findByText(
        "Open Findings went from 0 to 7 in 30 days; fix rate 9%.",
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(callsTo("/api/overview")).toHaveLength(2);
    expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  });

  it("after three more answers about another Team, says the server isn't answering", async () => {
    open({}, { overview: () => answer({ team: "org_b", open_now: 99 }) });
    expect(
      await screen.findByText("Warden's server isn't answering", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(callsTo("/api/overview")).toHaveLength(4);
    expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  });
});
