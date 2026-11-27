// The Overview page (story 10, and spec #341's stories 8 and 9): the journey cards with their states in words and their
// bars, the trend line, the audit section with its answer, Setup pointer, Control rows and credit, and each answer GET
// /api/overview can get. It renders OverviewPage alone with spy props, Warden's server faked. Which card is in which
// state, and the trend's and the answer's wordings, are tested below the page, in overview.test.ts.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OverviewBody, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "../src/Overview.tsx";
import { auditRow, ISA, isaOn, NO_CATALOGUE, reviewedRow } from "./audit-fixture.ts";
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
  audit: NO_CATALOGUE,
  last_scan_at: SCANNED,
  has_findings: true,
  period_days: 30,
  open_at_start: 0,
  open_now: 7,
  fix_rate: { fixed: 1, of: 11 },
  ...fields,
});

const answer = (fields: Partial<OverviewBody> = {}) => json(200, overview(fields));

/**
 * Renders OverviewPage for an Admin (or `role`) with GET /api/overview answering `fields` unless `routes` says
 * otherwise.
 */
function open(
  fields: Partial<OverviewBody> = {},
  routes: Routes = {},
  role: Role | null = "admin",
) {
  window.history.replaceState(null, "", "/overview");
  serve({ overview: () => answer(fields), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_ada", team: TEAM, role, level: "quick" as const },
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
  it("shows each card's word, what it adds, its bar, its state in words and its notes", async () => {
    open();
    await screen.findByRole("list", { name: "The journey" });
    const quick = cardOf("Quick");
    expect(quick.getByText("Repo scan and top fixes")).toBeInTheDocument();
    expect(quick.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(quick.getByText("Current")).toBeInTheDocument();
    expect(quick.getByText(`Last Scan: ${scannedOn}`)).toBeInTheDocument();
    expect(quick.getByText("Next: Standard adds the agent hook and the Judge")).toBeInTheDocument();
  });

  it("marks only the current card with aria-current=step, and says Done in words (a standard answer)", async () => {
    open({ level: "standard" });
    await screen.findByRole("list", { name: "The journey" });
    const current = within(journey())
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "step");
    expect(current.map((li) => li.querySelector(".journey-level")?.textContent)).toEqual([
      "Standard",
    ]);
    expect(cardOf("Quick").getByText("Done")).toBeInTheDocument();
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

const auditSection = async () =>
  within(await screen.findByRole("region", { name: "Are we ready for the audit?" }));
const NO_CATALOGUE_LINE = "Warden can answer this at Audit-ready, once Vouch checks your Controls.";
const rowsOf = async () =>
  (await auditSection())
    .getByRole("list", { name: "VDA ISA 2027.1 Controls" })
    .querySelectorAll<HTMLElement>(":scope > li");
/** The row of Control `ref`. */
const rowOf = async (ref: string) => {
  const row = [...(await rowsOf())].find(
    (li) => li.querySelector(".audit-ref")?.textContent === ref,
  );
  if (row === undefined) throw new Error(`no row for ${ref}`);
  return within(row);
};

describe("the audit section with no Catalogue on (spec #341)", () => {
  it("points an Admin to Setup's Catalogues, under the muted line, with no Control list", async () => {
    open();
    const audit = await auditSection();
    expect(audit.getByText(NO_CATALOGUE_LINE)).toHaveClass("muted");
    const setup = audit.getByRole("link", { name: "Setup" });
    expect(setup).toHaveAttribute("href", "/setup#setup-catalogues");
    expect(setup.parentElement).toHaveTextContent(/^Turn on a Catalogue on Setup\.$/);
    expect(setup.parentElement).toHaveClass("setup-line");
    expect(audit.queryByRole("list")).toBeNull();
  });

  it.each(["lead", "member"] as const)(
    "tells a %s an Admin turns one on, with no link",
    async (role) => {
      open({}, {}, role);
      const audit = await auditSection();
      expect(audit.getByText("An Admin turns on a Catalogue on Setup.")).toBeInTheDocument();
      expect(audit.queryByRole("link")).toBeNull();
      expect(audit.queryByRole("list")).toBeNull();
    },
  );

  it("shows no pointer while the role isn't known", async () => {
    open({}, {}, null);
    const audit = await auditSection();
    expect(audit.getByText(NO_CATALOGUE_LINE)).toBeInTheDocument();
    expect(audit.queryByRole("link")).toBeNull();
    expect(audit.queryByText("An Admin turns on a Catalogue on Setup.")).toBeNull();
  });
});

describe("the audit section with ISA2027 on (spec #341, story 8)", () => {
  it("answers in one line in the heading font, with no Setup pointer", async () => {
    open({ audit: isaOn({ gaps: 2, waiting: 1 }) });
    const audit = await auditSection();
    expect(audit.getByText("Not yet: 2 Gaps, 1 Control waiting for review.")).toHaveClass(
      "audit-answer",
    );
    expect(audit.queryByText(NO_CATALOGUE_LINE)).toBeNull();
    expect(audit.queryByRole("link", { name: "Setup" })).toBeNull();
  });

  it("lists its Controls under an h3 of its name, in the server's order, each with its ref, question and words", async () => {
    open({ audit: isaOn() });
    const audit = await auditSection();
    expect(audit.getByRole("heading", { level: 3, name: "VDA ISA 2027.1" })).toBeInTheDocument();
    const rows = [...(await rowsOf())];
    expect(rows.map((row) => row.querySelector(".audit-ref")?.textContent)).toEqual([
      "1.3.3",
      "1.3.4",
      "4.1.3",
      "5.2.4",
    ]);
    const first = within(rows[0]!);
    expect(first.getByText("Question 1.3.3?")).toBeInTheDocument();
    expect(first.getByText("Not evidenced")).toHaveClass("audit-verdict");
    expect(first.getByText("Not reviewed")).toBeInTheDocument();
  });

  it("shows the reviewed Verdict while reviewed, and the worked-out one otherwise", async () => {
    open({
      audit: isaOn({
        controls: [
          auditRow("1.3.3", {
            verdict: "evidenced",
            review_state: "reviewed",
            reviewed_verdict: "not_applicable",
          }),
          auditRow("1.3.4", {
            verdict: "partly_evidenced",
            review_state: "changed_since_review",
            reviewed_verdict: null,
          }),
          auditRow("4.1.3", { verdict: "evidenced" }),
        ],
      }),
    });
    const overridden = await rowOf("1.3.3");
    expect(overridden.getByText("Not applicable")).toBeInTheDocument();
    expect(overridden.getByText("Reviewed")).toBeInTheDocument();
    expect(overridden.queryByText("Evidenced")).toBeNull();
    const changed = await rowOf("1.3.4");
    expect(changed.getByText("Partly evidenced")).toBeInTheDocument();
    expect(changed.getByText("Changed since review")).toBeInTheDocument();
    const notReviewed = await rowOf("4.1.3");
    expect(notReviewed.getByText("Evidenced")).toBeInTheDocument();
    expect(notReviewed.getByText("Not reviewed")).toBeInTheDocument();
  });

  it("shows Gap in a pill on a Gap's row only", async () => {
    open({
      audit: isaOn({
        gaps: 1,
        controls: [
          auditRow("1.3.3", {
            review_state: "reviewed",
            reviewed_verdict: "not_evidenced",
            gap: true,
          }),
          reviewedRow("1.3.4"),
        ],
      }),
    });
    expect((await rowOf("1.3.3")).getByText("Gap")).toHaveClass("audit-gap");
    expect((await rowOf("1.3.4")).queryByText("Gap")).toBeNull();
  });

  it("gives the credit and the licence, a link opening in a new tab, under the rows", async () => {
    open({ audit: isaOn() });
    const audit = await auditSection();
    const credit = audit.getByText("© 2026 ENX Association.");
    expect(credit).toHaveClass("muted");
    const licence = audit.getByRole("link", { name: "CC BY-ND 4.0" });
    expect(licence.parentElement).toHaveTextContent(/^Licence: CC BY-ND 4\.0$/);
    expect(licence).toHaveAttribute("href", ISA.licence_url);
    expect(licence).toHaveAttribute("target", "_blank");
    expect(licence).toHaveAttribute("rel", "noreferrer");
    const list = audit.getByRole("list", { name: "VDA ISA 2027.1 Controls" });
    expect(list.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("makes no row a button, a link or a focus stop: tabbing reaches only the licence link", async () => {
    open({ audit: isaOn() });
    const audit = await auditSection();
    for (const row of await rowsOf()) {
      expect(within(row).queryByRole("button")).toBeNull();
      expect(within(row).queryByRole("link")).toBeNull();
      expect(row.querySelector("[tabindex]")).toBeNull();
      expect(row).not.toHaveAttribute("tabindex");
    }
    expect(audit.getAllByRole("link").map((link) => link.textContent)).toEqual(["CC BY-ND 4.0"]);
  });

  it("shows only the rows of the Catalogues the answer lists", async () => {
    open({ audit: isaOn({ catalogues: [] }) });
    const audit = await auditSection();
    expect(audit.getByText("Not yet: 4 Controls waiting for review.")).toBeInTheDocument();
    expect(audit.queryAllByRole("listitem")).toEqual([]);
  });
});

describe("the journey with a Catalogue on (spec #341, story 9)", () => {
  it("gives the Audit-ready card the answer's count of Controls reviewed", async () => {
    open({ audit: isaOn({ waiting: 3, controls: [reviewedRow("1.3.3"), auditRow("1.3.4")] }) });
    await screen.findByRole("list", { name: "The journey" });
    expect(cardOf("Audit-ready").getByText("1 of 2 Controls reviewed")).toBeInTheDocument();
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
