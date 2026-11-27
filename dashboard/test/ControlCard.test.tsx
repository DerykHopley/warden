// The Control card (spec #341, slices 7a and 7b; docs/design.md: Control detail card): its header with the Catalogue's
// credit, the Verdict with its review state and reason, the evidence with its Open Findings as links, the reviews, and
// each answer its read can get; then the review form a Lead or an Admin confirms or overrides with, one review per
// submit, each answer its POST can get, and a Member's line. It renders ControlCard alone with spy props, Warden's
// server faked. The reason's, the evidence's and the review lines' words, and the POST's mapping, are tested below the
// card (vouch.test.ts): here the card shows them; selecting a Control on the Overview, in Overview.test.tsx.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControlDetail, ControlReview, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ANSWERING, TEAM_NOT_OPENED, tryAgainIn } from "../src/api.ts";
import { ControlCard } from "../src/ControlCard.tsx";
import { dayAndTimeWords } from "../src/date-words.ts";
import type { ClerkUser } from "../src/person-name.ts";
import { judgeRunLine, ruleEvidenceWords, verdictReasonLine } from "../src/vouch.ts";
import { auditRow, controlDetail, ISA } from "./audit-fixture.ts";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { PRODUCT_ID, SHOP_WEB, TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const PATH = "/api/vouch/catalogues/vda-isa-2027.1/controls/1.3.3";
const REVIEWED_AT = "2026-11-25T10:30:00Z";
const EARLIER = "2026-11-20T08:00:00Z";

const me = () => json(200, { userId: "user_ada", team: TEAM, role: "member", level: "quick" });
const detailOf = (fields: Partial<ControlDetail> = {}) =>
  controlDetail("1.3.3", { question: "Is AI tool use approved?", ...fields });
const answer = (fields: Partial<ControlDetail> = {}) => json(200, detailOf(fields));

const GRACE: ClerkUser = { firstName: "Grace", lastName: "Hopper", identifier: "grace@acme.test" };

/**
 * Renders the card on ISA2027's 1.3.3 for user_ada with `role` (a Member unless said), its read answering `fields`
 * unless `routes` says otherwise.
 */
function show(
  fields: Partial<ControlDetail> = {},
  routes: Routes = {},
  role: Role | null = "member",
) {
  serve({ me, control: () => answer(fields), ...routes });
  const props = {
    focus: {
      catalogue: ISA,
      control: auditRow("1.3.3", { question: "Is AI tool use approved?" }),
      clear: vi.fn(),
      refreshRow: vi.fn(),
    },
    team: TEAM,
    getToken: vi.fn(async () => "session-token" as string | null),
    userId: "user_ada",
    role,
    refreshMe: vi.fn(),
    clerkUsers: new Map([["user_grace", GRACE]]),
    onClear: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  const view = render(<ControlCard {...props} />);
  return {
    ...props,
    props,
    ...view,
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

  it("a reviewed override to not applicable reads Not applicable, Reviewed, its reason saying which Verdict it explains", async () => {
    const overridden = {
      verdict: "not_evidenced",
      review_state: "reviewed",
      reviewed_verdict: "not_applicable",
    } as const;
    show(overridden);
    const verdict = await section("Verdict");
    expect(verdict.getByText("Not applicable").tagName).toBe("STRONG");
    expect(verdict.getByText("Reviewed")).toBeVisible();
    expect(verdict.getByText(verdictReasonLine(controlDetail("1.3.3", overridden)))).toHaveClass(
      "control-reason",
    );
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
    const [covered] = controlDetail("1.3.3").evidence.rules;
    expect(rule.parentElement!.textContent).toBe(
      `guard/unapproved-ai-tool: ${ruleEvidenceWords(covered!)}`,
    );
  });

  it("a Control with no Rules (5.2.4) shows its Judge run line instead", async () => {
    show({ evidence: { rules: [], judge_spot_run_at: null, open_findings: [] } });
    const evidence = await section("Evidence");
    expect(evidence.getByText(judgeRunLine(null))).toBeVisible();
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

  it("names a Product Asset by its Product's name, as Findings does", async () => {
    show(
      {
        evidence: {
          ...controlDetail("1.3.3").evidence,
          open_findings: [
            {
              id: "f-cve",
              rule_id: "patch/known-cve",
              title: "lodash has a known CVE",
              severity: "high",
              asset: { kind: "product", ref: PRODUCT_ID },
            },
          ],
        },
      },
      { products: () => json(200, { team: TEAM, products: [SHOP_WEB] }) },
    );
    const findings = within(
      (await section("Evidence")).getByRole("list", { name: "Open Findings" }),
    );
    expect(
      await findings.findByRole("link", { name: "lodash has a known CVE High · Shop web" }),
    ).toBeVisible();
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
        focus={{ catalogue: ISA, control: auditRow("1.3.3"), clear: vi.fn(), refreshRow: vi.fn() }}
        team={TEAM}
        getToken={getTokens}
        userId="user_ada"
        role="member"
        refreshMe={vi.fn()}
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

describe("a Member (story 5)", () => {
  it("sees no Confirm, Override or form, only the muted line A Lead or an Admin reviews this Control.", async () => {
    const { card } = show();
    const reviews = await section("Reviews");
    expect(reviews.getByText("A Lead or an Admin reviews this Control.")).toHaveClass("muted");
    expect(card.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Clear the focus",
    ]);
    expect(card.queryByRole("form")).toBeNull();
    expect(card.queryByRole("textbox")).toBeNull();
    expect(card.queryByRole("radio")).toBeNull();
  });

  it("with the Role not yet known, sees neither the buttons nor the line", async () => {
    const { card } = show({}, {}, null);
    await section("Reviews");
    expect(card.queryByText("A Lead or an Admin reviews this Control.")).toBeNull();
    expect(card.getAllByRole("button")).toHaveLength(1);
  });
});

const REVIEWS = `${PATH}/reviews`;
/** Ada's confirm of the worked-out Not evidenced, as the 201's detail lists it first. */
const ADAS_CONFIRM = review({
  id: "r-new",
  worked_out_verdict: "not_evidenced",
  verdict: "not_evidenced",
  reviewed_by: "user_ada",
  reviewed_at: REVIEWED_AT,
});
const confirmed = () =>
  json(
    201,
    detailOf({
      review_state: "reviewed",
      reviewed_verdict: "not_evidenced",
      reviews: [ADAS_CONFIRM, review({ id: "r-1" })],
    }),
  );
const sentBodies = () => callsTo(REVIEWS).map(([, init]) => JSON.parse(String(init?.body)));

/** Shows 1.3.3's card to a Lead (unless said) and opens the form `name`'s button opens, once the read has answered. */
async function openForm(
  name: "Confirm" | "Override",
  routes: Routes = {},
  role: Role = "lead",
  fields: Partial<ControlDetail> = {},
) {
  const shown = show(fields, routes, role);
  await userEvent.click((await section("Reviews")).getByRole("button", { name }));
  const form = within(screen.getByRole("form", { name: `${name} the Verdict` }));
  return { ...shown, form, submit: () => form.getByRole("button", { name }) };
}

/** Fills Override's form: a Verdict and a reason. */
async function fillOverride(form: ReturnType<typeof within>, verdict = "Not applicable") {
  await userEvent.click(form.getByRole("radio", { name: verdict }));
  await userEvent.type(form.getByRole("textbox", { name: "Reason" }), "We use no AI tools");
}

describe("the review form (story 4)", () => {
  it.each<Role>(["lead", "admin"])(
    "a %s sees Confirm and Override under Reviews once the read answers, as secondary buttons",
    async (role) => {
      const late = deferred<Response>();
      const { card } = show({}, { control: () => late.promise }, role);
      expect(card.queryByRole("button", { name: "Confirm" })).toBeNull();
      late.resolve(answer());
      const reviews = await section("Reviews");
      const buttons = within(reviews.getByRole("group", { name: "Review" })).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["Confirm", "Override"]);
      for (const button of buttons) expect(button).toHaveClass("secondary");
      expect(reviews.queryByText("A Lead or an Admin reviews this Control.")).toBeNull();
    },
  );

  it.each([
    ["reviewed", { review_state: "reviewed", reviewed_verdict: "not_evidenced" }],
    ["changed since review", { review_state: "changed_since_review", reviewed_verdict: null }],
  ] as const)("offers them while %s too", async (_, fields) => {
    show(fields, {}, "lead");
    const reviews = await section("Reviews");
    expect(reviews.getByRole("button", { name: "Confirm" })).toBeVisible();
    expect(reviews.getByRole("button", { name: "Override" })).toBeVisible();
  });

  it("Confirm opens its form in place of the row: an optional Reason, focused, the Confirm submit and Cancel", async () => {
    const { card, form, submit } = await openForm("Confirm");
    expect(card.queryByRole("group", { name: "Review" })).toBeNull();
    const reason = form.getByRole("textbox", { name: "Reason (optional)" });
    expect(reason).toHaveFocus();
    expect(reason).toHaveAttribute("maxlength", "2000");
    expect(submit()).toHaveClass("primary");
    expect(submit()).toBeEnabled();
    expect(form.getByRole("button", { name: "Cancel" })).toHaveClass("secondary");
    expect(form.queryByRole("radio")).toBeNull();
  });

  it.each([
    ["an empty reason", "", { outcome: "confirm" }],
    ["a blank reason", "   ", { outcome: "confirm" }],
    [
      "a reason",
      "  Checked the tool list  ",
      { outcome: "confirm", reason: "Checked the tool list" },
    ],
  ])(
    "Confirm with %s sends the confirm, the reason only when given, with the token /api/me confirmed the Team with",
    async (_, typed, body) => {
      const { form, submit, getToken } = await openForm("Confirm", { review: confirmed });
      let tokens = 0;
      getToken.mockImplementation(async () => `token-${++tokens}`);
      if (typed !== "") await userEvent.type(form.getByRole("textbox"), typed);
      await userEvent.click(submit());

      await vi.waitFor(() => expect(callsTo(REVIEWS)).toHaveLength(1));
      expect(sentBodies()).toEqual([body]);
      const [, meInit] = callsTo("/api/me").at(-1)!;
      const [[, init] = []] = callsTo(REVIEWS);
      expect(init?.method).toBe("POST");
      expect(new Headers(meInit?.headers).get("Authorization")).toBe("Bearer token-1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    },
  );

  it.each([
    ["not evidenced", "not_evidenced", ["Evidenced", "Partly evidenced", "Not applicable"]],
    ["partly evidenced", "partly_evidenced", ["Evidenced", "Not evidenced", "Not applicable"]],
  ] as const)(
    "Override, on a Control worked out as %s, offers only the other Verdicts, the first one focused",
    async (_, verdict, offered) => {
      const { form } = await openForm("Override", {}, "admin", { verdict });
      const radios = form.getAllByRole("radio");
      expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual(offered);
      expect(radios[0]).toHaveFocus();
      expect(form.getByRole("group", { name: "Verdict" })).toBeVisible();
    },
  );

  it("Override stays disabled until a Verdict is picked and the reason isn't blank, then sends the override", async () => {
    const { form, submit } = await openForm("Override", { review: confirmed });
    const reason = form.getByRole("textbox", { name: "Reason" });
    expect(reason).toHaveAttribute("maxlength", "2000");
    expect(submit()).toBeDisabled();
    await userEvent.type(reason, "We use no AI tools");
    expect(submit()).toBeDisabled();
    await userEvent.click(form.getByRole("radio", { name: "Not applicable" }));
    expect(submit()).toBeEnabled();
    await userEvent.clear(reason);
    await userEvent.type(reason, "   ");
    expect(submit()).toBeDisabled();
    await userEvent.type(reason, "We use no AI tools  ");
    expect(submit()).toBeEnabled();

    await userEvent.click(submit());
    await vi.waitFor(() => expect(callsTo(REVIEWS)).toHaveLength(1));
    expect(sentBodies()).toEqual([
      { outcome: "override", verdict: "not_applicable", reason: "We use no AI tools" },
    ]);
  });

  it("a 201 shows the answer's new review first, closes the form, focuses the Done line Confirmed. and calls refreshRow once", async () => {
    const { card, form, submit, focus } = await openForm("Confirm", { review: confirmed });
    await userEvent.type(form.getByRole("textbox"), "Checked");
    await userEvent.click(submit());

    const done = await card.findByRole("status");
    expect(done).toHaveTextContent(/^Confirmed\.$/);
    expect(done).toHaveFocus();
    expect(card.queryByRole("form")).toBeNull();
    expect(card.getByRole("group", { name: "Review" })).toBeVisible();
    const [newest] = within((await section("Reviews")).getByRole("list")).getAllByRole("listitem");
    expect(within(newest!).getByText("Confirmed: Not evidenced")).toBeVisible();
    expect(within(newest!).getByText(/^By you,/)).toBeVisible();
    expect((await section("Verdict")).getByText("Reviewed")).toBeVisible();
    // The answer is the card's: it isn't read again, and the row is asked for once, not again by the answer's own check.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(focus.refreshRow).toHaveBeenCalledOnce();
    expect(callsTo(PATH)).toHaveLength(1);
  });

  it("an override's Done line names the picked Verdict: Overridden to Not applicable.", async () => {
    const overridden = () =>
      json(
        201,
        detailOf({
          review_state: "reviewed",
          reviewed_verdict: "not_applicable",
          reviews: [{ ...ADAS_CONFIRM, outcome: "overridden", verdict: "not_applicable" }],
        }),
      );
    const { card, form, submit, focus } = await openForm("Override", { review: overridden });
    await fillOverride(form);
    await userEvent.click(submit());

    expect(await card.findByRole("status")).toHaveTextContent(/^Overridden to Not applicable\.$/);
    expect((await section("Verdict")).getByText("Not applicable").tagName).toBe("STRONG");
    expect(focus.refreshRow).toHaveBeenCalledOnce();
  });

  it.each(["Confirm", "Override"] as const)(
    "%s's Cancel closes the form and puts focus back on the button that opened it; Esc does the same",
    async (name) => {
      const { card, form } = await openForm(name);
      await userEvent.click(form.getByRole("button", { name: "Cancel" }));
      expect(card.queryByRole("form")).toBeNull();
      expect(card.getByRole("button", { name })).toHaveFocus();

      await userEvent.click(card.getByRole("button", { name }));
      expect(card.getByRole("form")).toBeVisible();
      await userEvent.keyboard("{Escape}");
      expect(card.queryByRole("form")).toBeNull();
      expect(card.getByRole("button", { name })).toHaveFocus();
      expect(callsTo(REVIEWS)).toHaveLength(0);
    },
  );
});

describe("one review per submit", () => {
  it.each(["Confirm", "Override"] as const)(
    "two clicks on %s's submit in the same tick send one POST",
    async (name) => {
      const late = deferred<Response>();
      const { card, form, submit } = await openForm(name, { review: () => late.promise });
      if (name === "Override") await fillOverride(form);
      const button = submit();
      // Both clicks land before React renders the busy button.
      act(() => {
        button.click();
        button.click();
      });
      await vi.waitFor(() => expect(callsTo(REVIEWS)).toHaveLength(1));
      late.resolve(confirmed());
      expect(await card.findByRole("status")).toBeVisible();
      expect(callsTo(REVIEWS)).toHaveLength(1);
    },
  );

  it("pressing Enter twice in Confirm's form sends one POST, the submit disabled and aria-busy while it runs", async () => {
    const late = deferred<Response>();
    const { card, submit } = await openForm("Confirm", { review: () => late.promise });
    await userEvent.tab();
    expect(submit()).toHaveFocus();
    await userEvent.keyboard("{Enter}{Enter}");

    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAttribute("aria-busy", "true");
    await vi.waitFor(() => expect(callsTo(REVIEWS)).toHaveLength(1));
    await userEvent.keyboard("{Enter}");
    late.resolve(confirmed());
    expect(await card.findByRole("status")).toBeVisible();
    expect(callsTo(REVIEWS)).toHaveLength(1);
  });
});

describe("a review's refusals keep the form open with what was typed", () => {
  const notOpened = () => json(409, { error: "not opened" });
  const slowDown = () => json(429, {}, { "Retry-After": "30" });

  it.each<[string, Routes, string]>([
    ["a 400", { review: () => json(400, { error: "reason: Too long" }) }, "reason: Too long."],
    ["a 404", { review: () => json(404, { error: "No such Control" }) }, "No such Control."],
    [
      "a 404 with no words",
      { review: () => new Response(null, { status: 404 }) },
      "Warden refused this review.",
    ],
    ["a 409", { review: notOpened }, TEAM_NOT_OPENED],
    ["/api/me saying the Team isn't opened", { me: notOpened }, TEAM_NOT_OPENED],
    ["a 429 with Retry-After 30", { review: slowDown }, tryAgainIn(30)],
    ["too many sign-ins at /api/me", { me: slowDown }, tryAgainIn(30)],
  ])("%s shows its line in the form", async (_, failing, line) => {
    // /api/me answers the read as usual; `failing` answers from the review on.
    let meAnswer: () => Response | Promise<Response> = me;
    const { form, submit } = await openForm("Confirm", {
      me: () => meAnswer(),
      review: failing.review ?? confirmed,
    });
    if (failing.me) meAnswer = failing.me;
    await userEvent.type(form.getByRole("textbox"), "Checked the tool list");
    await userEvent.click(submit());

    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent(line);
    expect(alert).toHaveClass("card-line", "refused");
    expect(form.getByRole("textbox")).toHaveValue("Checked the tool list");
    expect(submit()).toBeEnabled();
    expect(submit()).not.toHaveAttribute("aria-busy", "true");
  });

  it("a 403 says only a Lead or an Admin can review, and asks for the Role again; once it's lowered, the line stays with the Member's", async () => {
    const { card, form, submit, refreshMe, rerender, props } = await openForm("Override", {
      review: () => json(403, { error: "Lead only" }),
    });
    await fillOverride(form);
    await userEvent.click(submit());

    expect(await form.findByRole("alert")).toHaveTextContent(
      "Only a Lead or an Admin can review a Control.",
    );
    expect(form.getByRole("textbox")).toHaveValue("We use no AI tools");
    expect(refreshMe).toHaveBeenCalledOnce();

    rerender(<ControlCard {...props} role="member" />);
    expect(card.queryByRole("form")).toBeNull();
    expect(card.getByRole("alert")).toHaveTextContent(
      "Only a Lead or an Admin can review a Control.",
    );
    expect(card.getByText("A Lead or an Admin reviews this Control.")).toBeVisible();
  });

  it("while /api/me names another Team, sends no POST and says the server isn't answering", async () => {
    let team = TEAM;
    const review = vi.fn(confirmed);
    const { form, submit } = await openForm("Confirm", {
      me: () => json(200, { userId: "user_ada", team, role: "lead", level: "quick" }),
      review,
    });
    team = "org_left";
    await userEvent.click(submit());

    expect(await form.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(NOT_ANSWERING);
    expect(review).not.toHaveBeenCalled();
  });

  it("an ended session ends it, with no line", async () => {
    const { form, submit, onSessionEnded } = await openForm("Confirm", {
      review: () => json(401, {}),
    });
    await userEvent.click(submit());
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
    expect(form.queryByRole("alert")).toBeNull();
  });
});

describe("no answer to a review's POST", () => {
  it.each<[string, () => Response | Promise<Response>]>([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an answer that doesn't parse", () => json(201, { ...detailOf(), verdict: "maybe" })],
  ])(
    "%s says the review may have been saved, reads the Control again and asks for the row",
    async (_, failed) => {
      const { card, form, submit, focus } = await openForm("Confirm", { review: failed });
      await userEvent.type(form.getByRole("textbox"), "Checked");
      await userEvent.click(submit());

      expect(await form.findByRole("alert")).toHaveTextContent(
        "Warden's server didn't answer, so the review may have been saved. Check Reviews before you review again.",
      );
      expect(form.getByRole("textbox")).toHaveValue("Checked");
      await vi.waitFor(() => expect(callsTo(PATH)).toHaveLength(2));
      expect(focus.refreshRow).toHaveBeenCalledOnce();
      expect(card.getByRole("region", { name: "Verdict" })).toBeVisible();
    },
  );
});

describe("a review's answer after the card has gone", () => {
  it.each<[string, () => Response]>([
    ["a 201", confirmed],
    ["no answer", () => json(500, {})],
  ])(
    "%s shows nothing, and still asks for the row of the Control it was sent from",
    async (_, late) => {
      const answerLater = deferred<Response>();
      const { submit, focus, unmount } = await openForm("Confirm", {
        review: () => answerLater.promise,
      });
      await userEvent.click(submit());
      await vi.waitFor(() => expect(callsTo(REVIEWS)).toHaveLength(1));
      unmount();

      answerLater.resolve(late());
      await vi.waitFor(() => expect(focus.refreshRow).toHaveBeenCalledOnce());
      expect(callsTo(PATH)).toHaveLength(1);
    },
  );
});
