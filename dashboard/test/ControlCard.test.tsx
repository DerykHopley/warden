// The Control card (spec #341, slice 7a; docs/design.md: Control detail card): its header with the Catalogue's credit,
// the Verdict with its review state and reason, the evidence with its Open Findings as links, the reviews, and each
// answer its read can get. It renders ControlCard alone with spy props, Warden's server faked; the check that no Role
// gets a review control renders the whole App, Clerk faked. The evidence and review lines' words are tested below the
// card (vouch.test.ts); selecting a Control on the Overview, in Overview.test.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControlDetail, ControlReview, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { ControlCard } from "../src/ControlCard.tsx";
import { dayAndTimeWords } from "../src/date-words.ts";
import type { ClerkUser } from "../src/person-name.ts";
import { auditRow, controlDetail, ISA, isaOn, overviewBody } from "./audit-fixture.ts";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";
import { TEAM } from "./findings-fixture.ts";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const PATH = "/api/vouch/catalogues/vda-isa-2027.1/controls/1.3.3";
const REVIEWED_AT = "2026-11-25T10:30:00Z";
const EARLIER = "2026-11-20T08:00:00Z";

const me = () => json(200, { userId: "user_ada", team: TEAM, role: "member", level: "quick" });
const answer = (fields: Partial<ControlDetail> = {}) =>
  json(200, controlDetail("1.3.3", { question: "Is AI tool use approved?", ...fields }));

const GRACE: ClerkUser = { firstName: "Grace", lastName: "Hopper", identifier: "grace@acme.test" };

/** Renders the card on ISA2027's 1.3.3 for user_ada, its read answering `fields` unless `routes` says otherwise. */
function show(fields: Partial<ControlDetail> = {}, routes: Routes = {}) {
  serve({ me, control: () => answer(fields), ...routes });
  const props = {
    focus: {
      catalogue: ISA,
      control: auditRow("1.3.3", { question: "Is AI tool use approved?" }),
      clear: vi.fn(),
    },
    team: TEAM,
    getToken: vi.fn(async () => "session-token" as string | null),
    userId: "user_ada",
    clerkUsers: new Map([["user_grace", GRACE]]),
    onClear: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  render(<ControlCard {...props} />);
  return {
    ...props,
    card: within(screen.getByRole("region", { name: "Is AI tool use approved?" })),
  };
}

/** One of the card's sections, by its heading, once the read has answered. */
const section = async (name: string) => within(await screen.findByRole("region", { name }));

describe("the card's header", () => {
  it("shows the ref in mono, the question, the credit and the licence link at once, before the read answers", async () => {
    const late = deferred<Response>();
    const { card, onClear } = show({}, { control: () => late.promise });
    expect(card.getByText("1.3.3").tagName).toBe("CODE");
    expect(card.getByRole("heading", { level: 3, name: "Is AI tool use approved?" })).toBeVisible();
    expect(card.getByText("© 2026 ENX Association.")).toHaveClass("muted");
    const licence = card.getByRole("link", { name: "CC BY-ND 4.0" });
    expect(licence.parentElement).toHaveTextContent(/^Licence: CC BY-ND 4\.0$/);
    expect(licence).toHaveAttribute("href", ISA.licence_url);
    expect(licence).toHaveAttribute("target", "_blank");
    expect(licence).toHaveAttribute("rel", "noreferrer");

    await userEvent.click(card.getByRole("button", { name: "Clear the focus" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe("the Verdict (story 2)", () => {
  it("shows the shown Verdict's word in bold, the review state's word and the reason on the line under", async () => {
    show({ verdict: "not_evidenced", reason: "No Scan covered it in the last 30 days" });
    const verdict = await section("Verdict");
    expect(verdict.getByText("Not evidenced").tagName).toBe("STRONG");
    expect(verdict.getByText("Not reviewed")).toBeVisible();
    expect(verdict.getByText("No Scan covered it in the last 30 days")).toBeVisible();
    expect(
      verdict.queryByText("The Verdict worked out now differs from the one last reviewed."),
    ).toBeNull();
  });

  it("a reviewed override to not applicable reads Not applicable, Reviewed", async () => {
    show({
      verdict: "not_evidenced",
      review_state: "reviewed",
      reviewed_verdict: "not_applicable",
    });
    const verdict = await section("Verdict");
    expect(verdict.getByText("Not applicable").tagName).toBe("STRONG");
    expect(verdict.getByText("Reviewed")).toBeVisible();
  });

  it("a Control changed since review at partly evidenced reads Partly evidenced, Changed since review and the changed line (story 7)", async () => {
    show({
      verdict: "partly_evidenced",
      review_state: "changed_since_review",
      reviewed_verdict: null,
    });
    const verdict = await section("Verdict");
    expect(verdict.getByText("Partly evidenced").tagName).toBe("STRONG");
    expect(verdict.getByText("Changed since review")).toBeVisible();
    expect(
      verdict.getByText("The Verdict worked out now differs from the one last reviewed."),
    ).toBeVisible();
  });
});

describe("the evidence (story 3)", () => {
  it("gives each Rule a line, its id in mono then its coverage", async () => {
    show();
    const evidence = await section("Evidence");
    const rule = evidence.getByText("guard/unapproved-ai-tool");
    expect(rule.tagName).toBe("CODE");
    expect(rule.parentElement).toHaveTextContent(
      /^guard\/unapproved-ai-tool: no Scan in the last 30 days, on 0 of 1 Repo$/,
    );
  });

  it("a Control with no Rules (5.2.4) shows its Judge Spot line instead", async () => {
    show({ evidence: { rules: [], judge_spot_run_at: null, open_findings: [] } });
    const evidence = await section("Evidence");
    expect(evidence.getByText("No Judge Spot run in the last 30 days.")).toBeVisible();
    expect(evidence.queryByText(/^guard\//)).toBeNull();
  });

  it("lists each Open Finding as a link to it on Findings, with its title, Severity word and Asset ref", async () => {
    show({
      evidence: {
        ...controlDetail("1.3.3").evidence,
        open_findings: [
          {
            id: "f-cursor",
            rule_id: "guard/unapproved-ai-tool",
            title: "Cursor is in use",
            severity: "high",
            asset: { kind: "repo", ref: "acme/api" },
          },
          {
            id: "f-copilot",
            rule_id: "guard/unapproved-ai-tool",
            title: "Copilot is in use",
            severity: "medium",
            asset: { kind: "repo", ref: "acme/web" },
          },
        ],
      },
    });
    const findings = within(
      (await section("Evidence")).getByRole("list", { name: "Open Findings" }),
    );
    const links = findings.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/findings?finding=f-cursor",
      "/findings?finding=f-copilot",
    ]);
    expect(links[0]).toHaveAccessibleName("Cursor is in use High · acme/api");
    expect(links[1]).toHaveAccessibleName("Copilot is in use Medium · acme/web");
  });

  it("says No Open Findings. with none", async () => {
    show();
    const evidence = await section("Evidence");
    expect(evidence.getByText("No Open Findings.")).toBeVisible();
    expect(evidence.queryByRole("link")).toBeNull();
  });
});

const review = (fields: Partial<ControlReview>): ControlReview => ({
  id: "r-1",
  worked_out_verdict: "partly_evidenced",
  outcome: "confirmed",
  verdict: "partly_evidenced",
  reason: null,
  reviewed_by: "user_grace",
  reviewed_at: EARLIER,
  ...fields,
});

describe("the reviews (story 5)", () => {
  it("lists them newest first, each with its outcome, its reason when given, and who and when", async () => {
    show({
      reviews: [
        review({
          id: "r-2",
          worked_out_verdict: "not_evidenced",
          outcome: "overridden",
          verdict: "not_applicable",
          reason: "We use no AI tools",
          reviewed_by: "user_ada",
          reviewed_at: REVIEWED_AT,
        }),
        review({ id: "r-1" }),
      ],
    });
    const items = within((await section("Reviews")).getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [newest, older] = items.map((item) => within(item));
    expect(newest!.getByText("Overridden to Not applicable, from Not evidenced")).toBeVisible();
    expect(newest!.getByText("We use no AI tools")).toBeVisible();
    expect(newest!.getByText(/^By you,/)).toHaveTextContent(
      `By you, ${dayAndTimeWords(REVIEWED_AT)}`,
    );
    expect(older!.getByText("Confirmed: Partly evidenced")).toBeVisible();
    expect(older!.getByText(/^By Grace Hopper,/)).toHaveTextContent(
      `By Grace Hopper, ${dayAndTimeWords(EARLIER)}`,
    );
    expect(items[1]!.querySelectorAll("p")).toHaveLength(2);
  });

  it("says No reviews yet. with none", async () => {
    show();
    const reviews = await section("Reviews");
    expect(reviews.getByText("No reviews yet.")).toBeVisible();
    expect(reviews.queryByRole("list")).toBeNull();
  });
});

describe("the read", () => {
  it("asks for the Control once the session is confirmed in the Team, with that answer's token, saying Loading the Control… while it waits", async () => {
    const late = deferred<Response>();
    const { card } = show({}, { control: () => late.promise });
    expect(card.getByText("Loading the Control…")).toHaveClass("muted");
    late.resolve(answer());
    expect(await section("Verdict")).toBeTruthy();
    expect(card.queryByText("Loading the Control…")).toBeNull();
    expect(callsTo("/api/me")).toHaveLength(1);
    expect(callsTo(PATH)).toEqual([
      [PATH, { method: "GET", headers: { Authorization: "Bearer session-token" } }],
    ]);
  });

  it("a 404 shows the server's words, muted, with no Retry", async () => {
    const { card } = show({}, { control: () => json(404, { error: "No such Control" }) });
    expect(await card.findByText("No such Control")).toHaveClass("muted");
    expect(card.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a 404 with no body says Warden doesn't judge this Control.", async () => {
    const { card } = show({}, { control: () => new Response(null, { status: 404 }) });
    expect(await card.findByText("Warden doesn't judge this Control.")).toHaveClass("muted");
    expect(card.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 403", () => json(403, { error: "no Team" })],
    ["a 409", () => json(409, { error: "not opened" })],
    ["a 500", () => json(500, { error: "boom" })],
    ["a body that doesn't parse", () => json(200, { ...controlDetail("1.3.3"), verdict: "maybe" })],
  ])(
    "%s shows Couldn't load the Control. with Retry, busy while it runs; Retry asks again and shows the card",
    async (_, failed) => {
      const again = deferred<Response>();
      const answers = [failed, () => again.promise];
      const { card } = show({}, { control: () => answers.shift()!() });
      expect(await card.findByText("Couldn't load the Control.")).toBeVisible();

      const retry = card.getByRole("button", { name: "Retry the Control" });
      expect(retry).toHaveTextContent(/^Retry$/);
      expect(retry).toHaveClass("secondary");
      await userEvent.click(retry);
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toBeDisabled();
      expect(callsTo(PATH)).toHaveLength(2);

      again.resolve(answer());
      expect(await section("Verdict")).toBeTruthy();
      expect(card.queryByText("Couldn't load the Control.")).toBeNull();
    },
  );

  it("a 429 with Retry-After 30 says to try again in 30 seconds, with Retry", async () => {
    const { card } = show(
      {},
      { control: () => json(429, { error: "slow down" }, { "Retry-After": "30" }) },
    );
    expect(
      await card.findByText("Too many sign-in attempts. Try again in 30 seconds."),
    ).toBeVisible();
    expect(card.getByRole("button", { name: "Retry the Control" })).toBeVisible();
  });

  it("a 401 ends the session and shows no refusal", async () => {
    const { card, onSessionEnded } = show({}, { control: () => json(401, { error: "no" }) });
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(card.queryByText("Couldn't load the Control.")).toBeNull();
    expect(card.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("right after a Team switch, a token for the Team just left reads nothing: the card waits for the Team's own token", async () => {
    let tokens = 0;
    const getTokens = async () => `token-${++tokens}` as string | null;
    const teamOf = (init: RequestInit | undefined) =>
      new Headers(init?.headers).get("Authorization") === "Bearer token-1" ? "org_left" : TEAM;
    serve({
      me: () => {
        const [, init] = callsTo("/api/me").at(-1)!;
        return json(200, {
          userId: "user_ada",
          team: teamOf(init),
          role: "member",
          level: "quick",
        });
      },
      control: () => {
        const [, init] = callsTo(PATH).at(-1)!;
        return teamOf(init) === TEAM ? answer() : json(404, { error: "No such Control" });
      },
    });
    render(
      <ControlCard
        focus={{ catalogue: ISA, control: auditRow("1.3.3"), clear: vi.fn() }}
        team={TEAM}
        getToken={getTokens}
        userId="user_ada"
        clerkUsers={new Map()}
        onClear={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    expect(await section("Verdict")).toBeTruthy();
    expect(screen.queryByText("No such Control")).toBeNull();
    expect(callsTo(PATH).map(([, init]) => teamOf(init))).toEqual([TEAM]);
  });
});

describe("no review control (slice 7b builds the form)", () => {
  it.each<Role>(["admin", "lead", "member"])(
    "as %s, the card shows with no Confirm, Override or other control but its ✕",
    async (role) => {
      resetClerk();
      clerk.auth.isSignedIn = true;
      clerk.auth.sessionId = "sess_1";
      clerk.auth.orgId = TEAM;
      clerk.orgNames = { [TEAM]: "Acme" };
      window.history.replaceState(null, "", "/overview?catalogue=vda-isa-2027.1&control=1.3.3");
      serve({
        me: () => json(200, { userId: "user_ada", team: TEAM, role, level: "quick" }),
        overview: () => json(200, overviewBody(TEAM, { audit: isaOn() })),
        control: () => answer(),
      });
      render(<App />);
      const panel = within(await screen.findByRole("complementary", { name: "Ask Warden" }));
      const card = within(panel.getByRole("region", { name: "Question 1.3.3?" }));
      await card.findByRole("region", { name: "Verdict" });
      expect(
        card.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Clear the focus"]);
      expect(card.queryByRole("textbox")).toBeNull();
      expect(card.queryByRole("radio")).toBeNull();
      expect(card.queryByRole("combobox")).toBeNull();
      expect(card.queryByRole("checkbox")).toBeNull();
    },
  );
});
