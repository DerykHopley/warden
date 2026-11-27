// The Overview page (story 10, and spec #341's stories 8 and 9): the journey cards with their states in words and their
// bars, the trend line, the audit section with its answer, Setup pointer, Control rows and credit, and each answer GET
// /api/overview can get. It renders OverviewPage alone with spy props, Warden's server faked; focusing a Control in
// the Ask Warden panel (spec #341, slice 7a) renders the whole App, Clerk faked. Which card is in which state, the
// trend's and the answer's wordings, and which rows a Catalogue shows with which Verdict, are tested below the page, in
// overview.test.ts; the Control card's parts, in ControlCard.test.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuditAnswer, OverviewBody, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../src/App.tsx";
import { OverviewPage } from "../src/Overview.tsx";
import { journeyCards } from "../src/overview.ts";
import { auditRow, controlDetail, ISA, isaOn, NO_CATALOGUE, reviewedRow } from "./audit-fixture.ts";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";
import { TEAM } from "./findings-fixture.ts";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

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
  agent_sessions: { hook_active: false, judged: 0, needs_human_review: 0 },
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
    panel: { setContext: vi.fn(), open: vi.fn(), uncover: vi.fn() },
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

  it("shows the row's Verdict by shownVerdict: an overridden one, not the worked-out one", async () => {
    open({
      audit: isaOn({
        controls: [
          auditRow("1.3.3", {
            verdict: "evidenced",
            review_state: "reviewed",
            reviewed_verdict: "not_applicable",
          }),
        ],
      }),
    });
    const overridden = await rowOf("1.3.3");
    expect(overridden.getByText("Not applicable")).toHaveClass("audit-verdict");
    expect(overridden.getByText("Reviewed")).toHaveClass("audit-review");
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

  it("makes each row one button holding all its parts, and no row a link", async () => {
    open({ audit: isaOn() });
    const audit = await auditSection();
    for (const row of await rowsOf()) {
      const [button, ...others] = within(row).getAllByRole("button");
      expect(others).toHaveLength(0);
      expect(button).toHaveClass("audit-control-button");
      expect(button!.parentElement).toBe(row);
      expect(
        button!.querySelectorAll(".audit-ref, .audit-question, .audit-verdict, .audit-review"),
      ).toHaveLength(4);
      expect(button).not.toHaveAttribute("aria-current");
    }
    expect(audit.getAllByRole("link").map((link) => link.textContent)).toEqual(["CC BY-ND 4.0"]);
  });

  it("tells the panel nothing with no Control in focus", async () => {
    const { panel } = open({ audit: isaOn() });
    await auditSection();
    expect(panel.setContext).toHaveBeenLastCalledWith(null);
    expect(panel.open).not.toHaveBeenCalled();
  });

  it("clears the panel's Control as the page goes", async () => {
    window.history.replaceState(null, "", "/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    serve({ overview: () => answer({ audit: isaOn() }) });
    const setContext = vi.fn();
    const { unmount } = render(
      <OverviewPage
        getToken={async () => "session-token"}
        me={{ userId: "user_ada", team: TEAM, role: "admin", level: "quick" }}
        onSessionEnded={vi.fn()}
        refreshMe={vi.fn()}
        panel={{ setContext, open: vi.fn(), uncover: vi.fn() }}
      />,
    );
    await vi.waitFor(() =>
      expect(setContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ control: expect.objectContaining({ catalogue: ISA }) }),
      ),
    );
    unmount();
    expect(setContext).toHaveBeenLastCalledWith(null);
  });
});

describe("focusing a Control (spec #341, slice 7a)", () => {
  beforeEach(() => {
    resetClerk();
    clerk.auth.isSignedIn = true;
    clerk.auth.sessionId = "sess_1";
    clerk.auth.orgId = TEAM;
    clerk.orgNames = { [TEAM]: "Acme" };
  });

  /** Opens `url` in the whole App as a Lead, ISA2027 on, each Control's read answering `control` unless given. */
  function openApp(url: string, control: Routes["control"] = (_, ref) => readOf(ref)) {
    window.history.replaceState(null, "", url);
    serve({
      me: () => json(200, { userId: "user_ada", team: TEAM, role: "lead", level: "quick" }),
      overview: () => answer({ audit: isaOn() }),
      control,
    });
    return render(<App />);
  }
  const readOf = (ref: string) =>
    json(200, controlDetail(ref, { reason: `Reason ${ref}`, question: `Question ${ref}?` }));

  const rowButton = async (ref: string) => (await rowOf(ref)).getByRole("button");
  const panel = () => screen.queryByRole("complementary", { name: "Ask Warden" });
  const cardOf = (ref: string) =>
    within(panel()!).queryByRole("region", { name: `Question ${ref}?` });
  const address = () => location.pathname + location.search;

  it("clicking a row puts it in the address in place, marks it current and opens a closed panel with its card", async () => {
    openApp("/overview");
    const button = await rowButton("1.3.3");
    expect(panel()).toBeNull();
    const entries = history.length;

    await userEvent.click(button);
    expect(address()).toBe("/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    expect(history.length).toBe(entries);
    expect(button).toHaveAttribute("aria-current", "true");
    expect(await rowButton("1.3.4")).not.toHaveAttribute("aria-current");
    expect(cardOf("1.3.3")).toBeVisible();
    expect(await within(cardOf("1.3.3")!).findByText("Reason 1.3.3")).toBeVisible();
  });

  it("a direct link to 1.3.4 selects it and opens its card", async () => {
    openApp("/overview?catalogue=vda-isa-2027.1&control=1.3.4");
    expect(await screen.findByRole("complementary", { name: "Ask Warden" })).toBeVisible();
    expect(await rowButton("1.3.4")).toHaveAttribute("aria-current", "true");
    expect(await within(cardOf("1.3.4")!).findByText("Reason 1.3.4")).toBeVisible();
    expect(address()).toBe("/overview?catalogue=vda-isa-2027.1&control=1.3.4");
  });

  // Which addresses name a Control the answer holds is focusedControl's, in overview.test.ts.
  it("a link to a Control the answer doesn't hold selects nothing, opens nothing, and only its params leave the address", async () => {
    openApp("/overview?tab=x&catalogue=vda-isa-2027.1&control=9.9.9#notes");
    for (const ref of ["1.3.3", "1.3.4", "4.1.3", "5.2.4"]) {
      expect(await rowButton(ref)).not.toHaveAttribute("aria-current");
    }
    await vi.waitFor(() => expect(address()).toBe("/overview?tab=x"));
    expect(location.hash).toBe("#notes");
    expect(panel()).toBeNull();
    expect(callsTo("/api/vouch/catalogues/vda-isa-2027.1/controls/9.9.9")).toHaveLength(0);
  });

  it("selecting a row changes only the Control in the address, keeping its other params, its hash and the entry's state", async () => {
    openApp("/overview?tab=x#notes");
    const button = await rowButton("1.3.3");
    history.replaceState({ kept: true }, "", location.href);

    await userEvent.click(button);
    expect(address()).toBe("/overview?tab=x&catalogue=vda-isa-2027.1&control=1.3.3");
    expect(location.hash).toBe("#notes");
    expect(history.state).toEqual({ kept: true });
  });

  it("a Team switch drops the focus, so a panel closed on the old Team stays closed on the new one", async () => {
    const { rerender } = openApp("/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    await screen.findByRole("complementary", { name: "Ask Warden" });
    await userEvent.click(screen.getByRole("button", { name: "Close Ask Warden" }));
    expect(panel()).toBeNull();

    clerk.auth.orgId = "org_b";
    clerk.orgNames = { ...clerk.orgNames, org_b: "Bluebird" };
    serve({
      me: () => json(200, { userId: "user_ada", team: "org_b", role: "lead", level: "quick" }),
      overview: () => json(200, { ...overview({ audit: isaOn() }), team: "org_b" }),
      control: (_, ref) => readOf(ref),
    });
    rerender(<App />);
    await vi.waitFor(() => expect(callsTo("/api/overview").length).toBeGreaterThanOrEqual(2));
    expect(await rowButton("1.3.3")).not.toHaveAttribute("aria-current");
    expect(address()).toBe("/overview");
    expect(panel()).toBeNull();
  });

  it("the card's ✕ removes the focus from the address, and the panel stays open", async () => {
    openApp("/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    await screen.findByRole("complementary", { name: "Ask Warden" });
    await userEvent.click(
      within(cardOf("1.3.3")!).getByRole("button", { name: "Clear the focus" }),
    );
    expect(address()).toBe("/overview");
    expect(panel()).toBeVisible();
    expect(cardOf("1.3.3")).toBeNull();
    expect(await rowButton("1.3.3")).not.toHaveAttribute("aria-current");
    expect(within(panel()!).getByText(/^Talking about:/)).toHaveTextContent(
      /^Talking about: view: Overview$/,
    );
  });

  it("when the card's read is newer than the row, the Overview asks again once, and the row shows what the card does", async () => {
    const reviewed = { verdict: "not_evidenced", review_state: "reviewed" } as const;
    const answers = [isaOn(), isaOn({ controls: [auditRow("1.3.3", reviewed)] })];
    window.history.replaceState(null, "", "/overview");
    serve({
      me: () => json(200, { userId: "user_ada", team: TEAM, role: "lead", level: "quick" }),
      overview: () => answer({ audit: answers.shift() ?? isaOn() }),
      control: (_, ref) => json(200, controlDetail(ref, reviewed)),
    });
    render(<App />);
    const row = await rowOf("1.3.3");
    expect(row.getByText("Not reviewed")).toBeVisible();

    await userEvent.click(row.getByRole("button"));
    expect(await row.findByText("Reviewed")).toBeVisible();
    expect(within(cardOf("1.3.3")!).getByText("Reviewed")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo("/api/overview")).toHaveLength(2);
  });

  it("a read that agrees with the row asks the Overview nothing more", async () => {
    openApp("/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    await screen.findByRole("complementary", { name: "Ask Warden" });
    expect(await within(cardOf("1.3.3")!).findByText("Reason 1.3.3")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo("/api/overview")).toHaveLength(1);
  });

  it("a read that answers after the focus moved to another Control doesn't show on that Control's card", async () => {
    const late = deferred<Response>();
    openApp("/overview", (_, ref) => (ref === "1.3.3" ? late.promise : readOf(ref)));
    await userEvent.click(await rowButton("1.3.3"));
    expect(await within(cardOf("1.3.3")!).findByText("Loading the Control…")).toBeVisible();

    await userEvent.click(await rowButton("1.3.4"));
    expect(await within(cardOf("1.3.4")!).findByText("Reason 1.3.4")).toBeVisible();
    late.resolve(readOf("1.3.3"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(panel()!).queryByText("Reason 1.3.3")).toBeNull();
    expect(cardOf("1.3.3")).toBeNull();
    expect(within(cardOf("1.3.4")!).getByText("Reason 1.3.4")).toBeVisible();
  });

  // Slice 7b: a Lead's review in the card, and the row after it (story 7).
  const REVIEWS_133 = "/api/vouch/catalogues/vda-isa-2027.1/controls/1.3.3/reviews";
  const confirmed133 = () =>
    json(
      201,
      controlDetail("1.3.3", {
        reason: "Reason 1.3.3",
        review_state: "reviewed",
        reviewed_verdict: "not_evidenced",
        reviews: [
          {
            id: "r-1",
            worked_out_verdict: "not_evidenced",
            outcome: "confirmed",
            verdict: "not_evidenced",
            reason: null,
            reviewed_by: "user_ada",
            reviewed_at: "2026-11-25T10:30:00Z",
          },
        ],
      }),
    );
  const confirmIn = async (card: HTMLElement) => {
    await userEvent.click(await within(card).findByRole("button", { name: "Confirm" }));
    await userEvent.click(
      within(within(card).getByRole("form")).getByRole("button", { name: "Confirm" }),
    );
  };

  it("after a review in the card, the Overview asks again once, and the row shows the new review state", async () => {
    const answers = [isaOn(), isaOn({ controls: [reviewedRow("1.3.3", "not_evidenced")] })];
    window.history.replaceState(null, "", "/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    serve({
      me: () => json(200, { userId: "user_ada", team: TEAM, role: "lead", level: "quick" }),
      overview: () => answer({ audit: answers.shift() ?? isaOn() }),
      control: (_, ref) => readOf(ref),
      review: confirmed133,
    });
    render(<App />);
    const row = await rowOf("1.3.3");
    expect(row.getByText("Not reviewed")).toBeVisible();
    await confirmIn(await vi.waitFor(() => cardOf("1.3.3")!));

    expect(await within(cardOf("1.3.3")!).findByRole("status")).toHaveTextContent("Confirmed.");
    expect(await row.findByText("Reviewed")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(REVIEWS_133)).toHaveLength(1);
    expect(callsTo("/api/overview")).toHaveLength(2);
  });

  it("a review's answer that arrives after the focus moved to another Control doesn't show on that Control's card, and the Overview still asks again", async () => {
    const late = deferred<Response>();
    openApp("/overview?catalogue=vda-isa-2027.1&control=1.3.3");
    serve({
      me: () => json(200, { userId: "user_ada", team: TEAM, role: "lead", level: "quick" }),
      overview: () => answer({ audit: isaOn() }),
      control: (_, ref) => readOf(ref),
      review: () => late.promise,
    });
    await confirmIn(await vi.waitFor(() => cardOf("1.3.3")!));
    await vi.waitFor(() => expect(callsTo(REVIEWS_133)).toHaveLength(1));

    await userEvent.click(await rowButton("1.3.4"));
    const card134 = within(cardOf("1.3.4")!);
    expect(await card134.findByText("Reason 1.3.4")).toBeVisible();
    late.resolve(confirmed133());
    await vi.waitFor(() => expect(callsTo("/api/overview")).toHaveLength(2));
    expect(card134.queryByRole("status")).toBeNull();
    expect(card134.queryByText("Confirmed: Not evidenced")).toBeNull();
    expect(card134.getByText("No reviews yet.")).toBeVisible();
    expect(cardOf("1.3.3")).toBeNull();
  });

  // #395: an answer asked for again that no longer holds the focused Control says so, above the journey.
  describe("when an answer asked for again no longer holds the focused Control (#395)", () => {
    /** ISA2027 still on, with every row but 1.3.3. */
    const without133 = () =>
      isaOn({ controls: ["1.3.4", "4.1.3", "5.2.4"].map((ref) => auditRow(ref)) });
    const card133 = () => screen.queryByRole("region", { name: "Question 1.3.3?" });

    /** Opens 1.3.3's card from a link as a Lead; the Overview answers ISA2027 on, then `next`. */
    function openThen(next: AuditAnswer, routes: Routes = {}) {
      const answers = [isaOn(), next];
      window.history.replaceState(null, "", "/overview?catalogue=vda-isa-2027.1&control=1.3.3");
      serve({
        me: () => json(200, { userId: "user_ada", team: TEAM, role: "lead", level: "quick" }),
        overview: () => answer({ audit: answers.length > 1 ? answers.shift()! : answers[0]! }),
        control: (_, ref) => readOf(ref),
        review: confirmed133,
        ...routes,
      });
      render(<App />);
      // The card once it shows; null once the notice has replaced it (a read newer than the row asks again at once),
      // which closes a floating panel.
      return vi.waitFor(() => {
        const card = card133();
        if (card === null && screen.queryByRole("alert") === null) throw new Error("Not yet");
        return card!;
      });
    }

    /** The notice reads `words` exactly, as the page's alert above the journey, and 1.3.3's card is gone. */
    async function expectNotice(words: string) {
      const notice = await screen.findByText(words);
      expect(notice.textContent).toBe(words);
      expect(notice).toHaveAttribute("role", "alert");
      expect(notice).toHaveClass("notice");
      expect(
        notice.compareDocumentPosition(journey()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await vi.waitFor(() => expect(card133()).toBeNull());
    }

    it("a confirm stored, then no Catalogue in the answer: the notice says it's stored and the Catalogue is off", async () => {
      await confirmIn(await openThen(NO_CATALOGUE));
      await expectNotice(
        "Confirmed. Your review of 1.3.3 is stored, but VDA ISA 2027.1 is off now, so the Overview doesn't show it.",
      );
      expect(address()).toBe("/overview");
    });

    it("an override to Not applicable stored, then no Catalogue: the notice starts with its Done words", async () => {
      const overridden = () =>
        json(
          201,
          controlDetail("1.3.3", {
            review_state: "reviewed",
            reviewed_verdict: "not_applicable",
            reviews: [
              {
                id: "r-1",
                worked_out_verdict: "not_evidenced",
                outcome: "overridden",
                verdict: "not_applicable",
                reason: "We use no AI tools",
                reviewed_by: "user_ada",
                reviewed_at: "2026-11-25T10:30:00Z",
              },
            ],
          }),
        );
      const card = within(await openThen(NO_CATALOGUE, { review: overridden }));
      await userEvent.click(await card.findByRole("button", { name: "Override" }));
      const form = within(card.getByRole("form"));
      await userEvent.click(form.getByRole("radio", { name: "Not applicable" }));
      await userEvent.type(form.getByRole("textbox", { name: "Reason" }), "We use no AI tools");
      await userEvent.click(form.getByRole("button", { name: "Override" }));
      await expectNotice(
        "Overridden to Not applicable. Your review of 1.3.3 is stored, but VDA ISA 2027.1 is off now, so the Overview doesn't show it.",
      );
    });

    it("a review with no answer, then no Catalogue: the notice says only that the Catalogue is off, not that it's stored", async () => {
      await confirmIn(
        await openThen(NO_CATALOGUE, {
          review: () => Promise.reject(new TypeError("Failed to fetch")),
        }),
      );
      await expectNotice("1.3.3 is no longer on the Overview: VDA ISA 2027.1 is off now.");
    });

    it("a read newer than the row, with no review, then no Catalogue: the notice says the Catalogue is off", async () => {
      await openThen(NO_CATALOGUE, {
        control: (_, ref) => json(200, controlDetail(ref, { review_state: "reviewed" })),
      });
      await expectNotice("1.3.3 is no longer on the Overview: VDA ISA 2027.1 is off now.");
    });

    it.each<[string, (card: HTMLElement) => Promise<void>, string, Routes]>([
      [
        "a stored review",
        confirmIn,
        "Confirmed. Your review of 1.3.3 is stored, but the Overview no longer shows it.",
        {},
      ],
      [
        "no review (a read newer than the row)",
        async () => {},
        "1.3.3 is no longer on the Overview.",
        { control: (_, ref) => json(200, controlDetail(ref, { review_state: "reviewed" })) },
      ],
    ])(
      "with the Catalogue still listed but not the row, after %s, the notice doesn't say it's off",
      async (_, step, words, routes) => {
        await step(await openThen(without133(), routes));
        await expectNotice(words);
      },
    );

    // Which shown states cover the page is the panel reducer's "uncover", in panel.test.ts.
    it.each<[number, string, "floating" | "pinned", string | null]>([
      [390, "closes the full-screen panel", "floating", null],
      [1024, "closes the floating panel", "floating", null],
      [1600, "closes the floating panel", "floating", null],
      [1600, "leaves the panel pinned beside the page", "pinned", "pinned"],
    ])("at %ipx the notice %s, so it can be read", async (width, _, chosen, shownAfter) => {
      window.innerWidth = width;
      onTestFinished(() => {
        window.innerWidth = 1024;
      });
      localStorage.setItem("warden.askWardenPanel", JSON.stringify({ mode: chosen, width: 400 }));
      await confirmIn(await openThen(NO_CATALOGUE));
      const words =
        "Confirmed. Your review of 1.3.3 is stored, but VDA ISA 2027.1 is off now, so the Overview doesn't show it.";
      await expectNotice(words);
      await vi.waitFor(() => expect(panel()?.dataset.shown ?? null).toBe(shownAfter));
      if (shownAfter === "pinned") {
        // #453: a panel the notice doesn't close keeps focus from moving to the notice.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.activeElement).not.toBe(screen.getByText(words));
      }
    });

    // #453: focus in a panel the notice closes would fall to <body>, and the first Tab to the closed Ask Warden button.
    it.each<[number, string]>([
      [390, "closes the full-screen panel and takes focus"],
      [1024, "closes the floating panel and takes focus"],
    ])("at %ipx, with focus in the card, the notice %s", async (width) => {
      window.innerWidth = width;
      onTestFinished(() => {
        window.innerWidth = 1024;
      });
      localStorage.setItem(
        "warden.askWardenPanel",
        JSON.stringify({ mode: "floating", width: 400 }),
      );
      const card = await openThen(without133());
      await confirmIn(card);
      // The card's Done line takes focus, in the panel, before the Overview's answer comes back.
      await vi.waitFor(() => expect(card).toContainElement(document.activeElement as HTMLElement));
      const words =
        "Confirmed. Your review of 1.3.3 is stored, but the Overview no longer shows it.";
      await expectNotice(words);
      const notice = screen.getByText(words);
      await vi.waitFor(() => expect(panel()).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(notice));
      await userEvent.tab();
      expect(document.activeElement).toBe(await rowButton("1.3.4"));
    });

    it("with focus on the page, not in the panel, the notice closes the panel and leaves focus where it was", async () => {
      const late = deferred<Response>();
      let asked = 0;
      await openThen(without133(), {
        overview: () => (++asked === 1 ? answer({ audit: isaOn() }) : late.promise),
        // A read newer than the row asks the answer again, with nothing pressed in the card.
        control: (_, ref) => json(200, controlDetail(ref, { review_state: "reviewed" })),
      });
      await vi.waitFor(() => expect(callsTo("/api/overview")).toHaveLength(2));
      const row = await rowButton("1.3.4");
      row.focus();

      late.resolve(answer({ audit: without133() }));
      await expectNotice("1.3.3 is no longer on the Overview.");
      await vi.waitFor(() => expect(panel()).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(row);
    });

    it("a review's 201 that lands after the focus moved to 1.3.4, then an answer without 1.3.3: no notice, and 1.3.4's card stays", async () => {
      const late = deferred<Response>();
      await confirmIn(await openThen(without133(), { review: () => late.promise }));
      await vi.waitFor(() => expect(callsTo(REVIEWS_133)).toHaveLength(1));

      await userEvent.click(await rowButton("1.3.4"));
      expect(await within(cardOf("1.3.4")!).findByText("Reason 1.3.4")).toBeVisible();
      late.resolve(confirmed133());
      await vi.waitFor(() => expect(callsTo("/api/overview")).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(within(cardOf("1.3.4")!).getByText("Reason 1.3.4")).toBeVisible();
    });

    it("clearing the focus with ✕, or selecting another row, shows no notice", async () => {
      const card = await openThen(without133());
      await userEvent.click(await rowButton("1.3.4"));
      expect(await within(cardOf("1.3.4")!).findByText("Reason 1.3.4")).toBeVisible();
      expect(card).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();

      await userEvent.click(
        within(cardOf("1.3.4")!).getByRole("button", { name: "Clear the focus" }),
      );
      expect(cardOf("1.3.4")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a link to a Control the first answer doesn't hold shows no notice", async () => {
      openApp("/overview?catalogue=vda-isa-2027.1&control=9.9.9");
      await vi.waitFor(() => expect(address()).toBe("/overview"));
      await rowButton("1.3.3");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("after the notice shows, selecting a Control row removes it", async () => {
      await openThen(without133(), {
        control: (_, ref) =>
          json(200, controlDetail(ref, ref === "1.3.3" ? { review_state: "reviewed" } : {})),
      });
      await expectNotice("1.3.3 is no longer on the Overview.");
      await userEvent.click(await rowButton("1.3.4"));
      expect(screen.queryByText("1.3.3 is no longer on the Overview.")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(cardOf("1.3.4")).toBeVisible();
    });
  });
});

describe("the journey with a Catalogue on (spec #341, story 9)", () => {
  it("gives the Audit-ready card the note journeyCards works out from the answer", async () => {
    const audit = isaOn({ waiting: 3, controls: [reviewedRow("1.3.3"), auditRow("1.3.4")] });
    open({ audit });
    await screen.findByRole("list", { name: "The journey" });
    const [note] = journeyCards("quick", SCANNED, audit, overview())[2]!.notes;
    expect(cardOf("Audit-ready").getByText(note!)).toHaveClass("journey-note");
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
