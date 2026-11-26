// The detail card's Fix PR section (#224, story 6): a Guard Finding's Fix PR link, read from
// `GET /api/guard/findings/:id/fix-pr`, and "Open a Fix PR" for an Open, fixable Finding while the Team holds a write
// grant (`GET /api/github/write-grant`), which sends `POST /api/guard/findings/:id/fix-pr`. It renders DetailCard,
// Warden's server faked; what each call is read into is fix-pr.test.ts's, and the card's other parts are
// DetailCard.test.tsx's.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, FixPrBody, Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAndTimeWords } from "../src/date-words.ts";
import { DetailCard } from "../src/DetailCard.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { finding } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "3f9a1c2e-0000-4000-8000-000000000001";
const FIX_PR_PATH = `/api/guard/findings/${ID}/fix-pr`;
const GRANT_PATH = "/api/github/write-grant";
const ME = "user_me";

/** An Open Guard Finding whose Rule and Location get a Fix PR. */
const OPEN: Finding = finding(ID);

const FIX_PR: FixPrBody = {
  url: "https://github.com/acme/shop-web/pull/12",
  number: 12,
  branch: `warden/fix-${ID}`,
  opened_by: ME,
  opened_at: "2026-11-24T12:30:00.000Z",
};

const GRANTED = {
  installations: [
    { installation_id: 7, granted_by: "user_admin", granted_at: "2026-11-20T09:00:00.000Z" },
  ],
};

const clerkUsers = new Map([
  ["user_grace", { firstName: "Grace", lastName: "Hopper", identifier: "grace@acme.test" }],
]);

/** /api/me's answer: the session is in `team`, the Finding's unless told. */
const inTeam =
  (team = OPEN.team) =>
  () =>
    json(200, { userId: ME, team, role: "member", level: "quick" });

/** The reads of an Open fixable Finding with no Fix PR yet, in a Team holding a write grant. */
const fixable = (fields: Partial<{ fix_pr: FixPrBody | null }> = {}): Routes => ({
  fixPr: () => json(200, { fixable: true, fix_pr: null, ...fields }),
  writeGrant: () => json(200, GRANTED),
});

const calls = {
  onFindingChanged: vi.fn(),
  onFindingGone: vi.fn(),
  onProposalsChanged: vi.fn(),
  onSessionEnded: vi.fn(),
};

/** Renders the card for `focused`, as a person with `role` (null: not loaded yet), with the server's routes `routes`. */
function show(focused: Finding, routes: Routes, role: Role | null = "member") {
  for (const call of Object.values(calls)) call.mockReset();
  serve({ me: inTeam(), ...routes });
  const element = (shown: Finding) => (
    <DetailCard
      finding={shown}
      proposals={{ kind: "proposals", team: shown.team, proposals: [] }}
      clerkUsers={clerkUsers}
      role={role}
      userId={ME}
      getToken={() => Promise.resolve("session-token")}
      candidates={[]}
      assetName={null}
      onClear={() => {}}
      onRetryProposals={() => {}}
      onFindingChanged={calls.onFindingChanged}
      onFindingGone={calls.onFindingGone}
      onProposalsChanged={calls.onProposalsChanged}
      refreshMe={() => {}}
      onSessionEnded={calls.onSessionEnded}
    />
  );
  const { rerender } = render(element(focused));
  return {
    card: within(screen.getByRole("region", { name: focused.title })),
    update: (shown: Finding) => rerender(element(shown)),
  };
}

type Card = ReturnType<typeof show>["card"];

/** The card's Fix PR section, once it has shown. */
const section = async (card: Card) => within(await card.findByRole("region", { name: "Fix PR" }));

/** Lets every call the card makes go out, and every answer land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The card once its reads have answered (/api/me and the Fix PR read, and the write grants when asked). */
async function shownAfterReads(card: Card, reads: number) {
  await vi.waitFor(() =>
    expect(callsTo(FIX_PR_PATH).length + callsTo(GRANT_PATH).length).toBe(reads),
  );
  await settle();
  return card;
}

const openButton = (card: Card) => card.findByRole("button", { name: "Open a Fix PR" });

describe("the Fix PR section's button", () => {
  it.each<Role>(["member", "lead", "admin"])(
    "on an Open, fixable Finding with a grant, a %s sees Open a Fix PR (secondary) under the heading Fix PR",
    async (role) => {
      const { card } = show(OPEN, fixable(), role);
      const fixPr = await section(card);
      expect(fixPr.getByRole("heading", { level: 4, name: "Fix PR" })).toBeVisible();
      const button = await openButton(card);
      expect(button).toHaveClass("secondary");
      expect(fixPr.getByRole("button", { name: "Open a Fix PR" })).toBe(button);
    },
  );

  it("sits under the card's fields and above its Decisions", async () => {
    const { card } = show(OPEN, fixable(), "lead");
    const region = await card.findByRole("region", { name: "Fix PR" });
    const fields = card.getAllByRole("term")[0]!.closest("dl")!;
    const decisions = card.getByRole("group", { name: "Decisions" });
    expect(fields.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      region.compareDocumentPosition(decisions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("while the Role hasn't loaded, shows no button", async () => {
    const { card } = show(OPEN, fixable(), null);
    await shownAfterReads(card, 2);
    expect(card.queryByRole("button", { name: "Open a Fix PR" })).toBeNull();
  });

  it.each<[Finding["status"], Partial<Finding>]>([
    [
      "accepted",
      { accepted_reason: "Patched next sprint", accepted_until: "2099-02-22T12:00:00Z" },
    ],
    ["false_positive", {}],
    ["fixed", {}],
  ])("a %s Finding answered fixable shows no button and no line", async (status, fields) => {
    const shown = finding(ID, { status, ...fields });
    const { card } = show(shown, fixable());
    await shownAfterReads(card, 1);
    expect(card.queryByRole("button", { name: "Open a Fix PR" })).toBeNull();
    expect(card.queryByRole("region", { name: "Fix PR" })).toBeNull();
  });

  it("an Accepted Finding holding a Fix PR still shows its link, and no button", async () => {
    const accepted = finding(ID, {
      status: "accepted",
      accepted_reason: "Patched next sprint",
      accepted_until: "2099-02-22T12:00:00Z",
    });
    const { card } = show(accepted, fixable({ fix_pr: FIX_PR }), "lead");
    const fixPr = await section(card);
    expect(fixPr.getByRole("link", { name: "Fix PR #12" })).toHaveAttribute("href", FIX_PR.url);
    expect(fixPr.queryByRole("button")).toBeNull();
  });

  it("with no write grant, says an Admin grants write access on Setup, muted, and shows no button", async () => {
    const { card } = show(OPEN, {
      fixPr: () => json(200, { fixable: true, fix_pr: null }),
      writeGrant: () => json(200, { installations: [] }),
    });
    const fixPr = await section(card);
    expect(
      await fixPr.findByText("An Admin grants write access on Setup to open Fix PRs."),
    ).toHaveClass("muted");
    expect(fixPr.queryByRole("button")).toBeNull();
  });

  it("a Finding that isn't fixable and has no Fix PR shows no heading and no line", async () => {
    const { card } = show(
      OPEN,
      { fixPr: () => json(200, { fixable: false, fix_pr: null }) },
      "admin",
    );
    await shownAfterReads(card, 1);
    expect(card.queryByRole("region", { name: "Fix PR" })).toBeNull();
    expect(card.queryByText(/Fix PR/)).toBeNull();
  });

  it("shows nothing while the reads are waiting", async () => {
    const late = deferred<Response>();
    const { card } = show(OPEN, { ...fixable(), fixPr: () => late.promise });
    await vi.waitFor(() => expect(callsTo(FIX_PR_PATH)).toHaveLength(1));
    expect(card.queryByRole("region", { name: "Fix PR" })).toBeNull();
    late.resolve(json(200, { fixable: true, fix_pr: null }));
    expect(await openButton(card)).toBeVisible();
  });
});

describe("the Fix PR section's link", () => {
  it("names the Fix PR by its number, opens it in a new tab, and says Opened by you and when", async () => {
    const { card } = show(OPEN, fixable({ fix_pr: FIX_PR }));
    const fixPr = await section(card);
    const link = fixPr.getByRole("link", { name: "Fix PR #12" });
    expect(link).toHaveAttribute("href", FIX_PR.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const opened = fixPr.getByText(/^Opened by you/);
    expect(opened).toHaveClass("muted");
    expect(opened).toHaveTextContent(`Opened by you, ${dayAndTimeWords(FIX_PR.opened_at)}`);
    // The button shows under the link: a second click gives back the PR still open.
    expect(fixPr.getByRole("button", { name: "Open a Fix PR" })).toBeVisible();
  });

  it("names someone else by their name in Clerk", async () => {
    const { card } = show(OPEN, fixable({ fix_pr: { ...FIX_PR, opened_by: "user_grace" } }));
    const fixPr = await section(card);
    expect(fixPr.getByText(/^Opened by/)).toHaveTextContent(/^Opened by Grace Hopper, /);
  });
});

describe("the Fix PR section's reads", () => {
  // A body that doesn't parse is read as not answering too, in fix-pr.test.ts: the section shows it as it shows a 500.
  it("a 500 shows Couldn't load the Fix PR. with Retry, busy while it runs; Retry asks again", async () => {
    const again = deferred<Response>();
    const answers = [() => json(500, { error: "boom" }), () => again.promise];
    const { card } = show(OPEN, { ...fixable(), fixPr: () => answers.shift()!() });
    const fixPr = await section(card);
    expect(await fixPr.findByText("Couldn't load the Fix PR.")).toHaveClass("muted");

    const retry = fixPr.getByRole("button", { name: "Retry the Fix PR" });
    expect(retry).toHaveTextContent(/^Retry$/);
    expect(retry).toHaveClass("secondary");
    await userEvent.click(retry);
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(retry).toBeDisabled();
    expect(callsTo(FIX_PR_PATH)).toHaveLength(2);

    again.resolve(json(200, { fixable: true, fix_pr: null }));
    expect(await openButton(card)).toBeVisible();
    expect(fixPr.queryByText("Couldn't load the Fix PR.")).toBeNull();
  });

  it("a write grants' read that fails shows Couldn't load the Fix PR. too", async () => {
    const { card } = show(OPEN, { ...fixable(), writeGrant: () => json(500, {}) });
    expect(await (await section(card)).findByText("Couldn't load the Fix PR.")).toBeVisible();
  });

  it("a 404 shows nothing", async () => {
    const { card } = show(OPEN, { fixPr: () => json(404, { error: "No such Finding" }) });
    await shownAfterReads(card, 1);
    expect(card.queryByRole("region", { name: "Fix PR" })).toBeNull();
  });

  it("a 429 from the Team check says to try again in 30 seconds, with Retry", async () => {
    const { card } = show(OPEN, { ...fixable(), me: () => json(429, {}, { "Retry-After": "30" }) });
    const fixPr = await section(card);
    expect(fixPr.getByText("Too many sign-in attempts. Try again in 30 seconds.")).toBeVisible();
    expect(fixPr.getByRole("button", { name: "Retry the Fix PR" })).toBeVisible();
  });

  it("a 401 ends the session", async () => {
    show(OPEN, { fixPr: () => json(401, { error: "signed out" }) });
    await vi.waitFor(() => expect(calls.onSessionEnded).toHaveBeenCalledOnce());
  });
});

describe("opening a Fix PR", () => {
  it("a 201 shows Fix PR #12 opened. with focus on it, and the link from the answer", async () => {
    const { card } = show(OPEN, { ...fixable(), openFixPr: () => json(201, FIX_PR) });
    await userEvent.click(await openButton(card));
    const fixPr = await section(card);
    const line = await fixPr.findByText("Fix PR #12 opened.");
    expect(line).toHaveClass("card-line");
    expect(line).toHaveAttribute("role", "status");
    expect(line).toHaveFocus();
    expect(fixPr.getByRole("link", { name: "Fix PR #12" })).toHaveAttribute("href", FIX_PR.url);
  });

  it("a 200 shows Fix PR #12 is still open.", async () => {
    const { card } = show(OPEN, { ...fixable(), openFixPr: () => json(200, FIX_PR) });
    await userEvent.click(await openButton(card));
    expect(await card.findByText("Fix PR #12 is still open.")).toHaveFocus();
    expect(card.getByRole("link", { name: "Fix PR #12" })).toBeVisible();
  });

  it("while the POST runs, the button is disabled and busy, and a second click sends nothing", async () => {
    const held = deferred<Response>();
    const { card } = show(OPEN, { ...fixable(), openFixPr: () => held.promise });
    const button = await openButton(card);
    await userEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    await userEvent.click(button);
    const posts = () => callsTo(FIX_PR_PATH).filter(([, init]) => init?.method === "POST");
    expect(posts()).toHaveLength(1);

    held.resolve(json(201, FIX_PR));
    await card.findByText("Fix PR #12 opened.");
    expect(button).not.toBeDisabled();
    expect(posts()).toHaveLength(1);
  });

  it("a 409 shows the server's words in an alert, asks both reads again and says the Finding changed; a grant gone hides the button", async () => {
    const grants = [() => json(200, GRANTED), () => json(200, { installations: [] })];
    const words =
      "The write app was uninstalled from GitHub; grant write access again on Setup to open Fix PRs";
    const { card } = show(OPEN, {
      fixPr: () => json(200, { fixable: true, fix_pr: null }),
      writeGrant: () => grants.shift()!(),
      openFixPr: () => json(409, { error: words }),
    });
    await userEvent.click(await openButton(card));
    const fixPr = await section(card);
    const line = await fixPr.findByRole("alert");
    expect(line).toHaveTextContent(`${words}.`);
    expect(line).toHaveClass("card-line", "refused");
    expect(calls.onFindingChanged).toHaveBeenCalledOnce();

    expect(
      await fixPr.findByText("An Admin grants write access on Setup to open Fix PRs."),
    ).toBeVisible();
    expect(fixPr.queryByRole("button", { name: "Open a Fix PR" })).toBeNull();
    expect(callsTo(FIX_PR_PATH).filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
    expect(callsTo(GRANT_PATH)).toHaveLength(2);
    // The button it was pressed on went: focus goes to the refusal, not to the page.
    expect(line).toHaveFocus();
  });

  it.each<[string, () => Response, string]>([
    // A 502 and a 503 are read as a 400 is, in fix-pr.test.ts.
    ["a 400", () => json(400, { error: "No Fix PR for this Rule" }), "No Fix PR for this Rule."],
    ["a 400 with no words", () => new Response(null, { status: 400 }), "Warden refused this."],
    [
      "a 429 with Retry-After 30",
      () => json(429, { error: "slow down" }, { "Retry-After": "30" }),
      "Too many Fix PRs. Try again in 30 seconds.",
    ],
  ])("%s shows its refusal line", async (_, answer, words) => {
    const { card } = show(OPEN, { ...fixable(), openFixPr: answer });
    await userEvent.click(await openButton(card));
    const line = await (await section(card)).findByRole("alert");
    expect(line).toHaveTextContent(new RegExp(`^${words.replace(/[.?]/g, "\\$&")}$`));
    expect(calls.onFindingChanged).not.toHaveBeenCalled();
  });

  it("a 404 says the Finding is no longer in the Team, and the page asks again", async () => {
    const { card } = show(OPEN, {
      ...fixable(),
      openFixPr: () => json(404, { error: "No such Finding" }),
    });
    await userEvent.click(await openButton(card));
    expect(await card.findByRole("alert")).toHaveTextContent(
      "This Finding is no longer in your Team.",
    );
    expect(calls.onFindingGone).toHaveBeenCalledOnce();
  });

  it("no answer to the POST says a Fix PR may have been opened, and asks the Fix PR read again", async () => {
    const { card } = show(OPEN, {
      ...fixable(),
      openFixPr: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await userEvent.click(await openButton(card));
    expect(await card.findByRole("alert")).toHaveTextContent(
      "Warden's server didn't answer, so a Fix PR may have been opened. Open a Fix PR again: it gives back the one already open.",
    );
    await vi.waitFor(() =>
      expect(callsTo(FIX_PR_PATH).filter(([, init]) => init?.method !== "POST")).toHaveLength(2),
    );
  });

  it("a 401 ends the session", async () => {
    const { card } = show(OPEN, {
      ...fixable(),
      openFixPr: () => json(401, { error: "signed out" }),
    });
    await userEvent.click(await openButton(card));
    await vi.waitFor(() => expect(calls.onSessionEnded).toHaveBeenCalledOnce());
  });

  // That no POST is sent is fix-pr.test.ts's (openFixPrInTeam); here, what the section says.
  it("when /api/me names another Team before the POST, says the server isn't answering", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let team = OPEN.team;
      const { card } = show(OPEN, {
        ...fixable(),
        me: () => inTeam(team)(),
        openFixPr: () => json(201, FIX_PR),
      });
      const button = await openButton(card);
      team = "org_left";
      button.click();
      await vi.runAllTimersAsync();
      expect(await card.findByRole("alert")).toHaveTextContent(
        /^Warden's server isn't answering\. Try again\.$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, () => Response, string]>([
    [
      "a Team not opened",
      () => json(409, { error: "not opened" }),
      "Your Team's Admin must open Warden first. Try again once they have.",
    ],
    [
      "a 429",
      () => json(429, {}, { "Retry-After": "30" }),
      "Too many sign-in attempts. Try again in 30 seconds.",
    ],
  ])("the Team check's %s before the POST says so", async (_, me, words) => {
    const answers = [inTeam(), me];
    const { card } = show(OPEN, {
      ...fixable(),
      me: () => answers.shift()!(),
      openFixPr: () => json(201, FIX_PR),
    });
    await userEvent.click(await openButton(card));
    expect(await card.findByRole("alert")).toHaveTextContent(words);
  });

  it("the section's line doesn't take the card's own: after a refused Fix PR, a decision's Done line takes focus", async () => {
    const { card } = show(
      OPEN,
      {
        ...fixable(),
        openFixPr: () => json(400, { error: "No Fix PR for this Rule" }),
        findingAction: () => json(200, { ...OPEN, status: "false_positive" }),
      },
      "lead",
    );
    await userEvent.click(await openButton(card));
    await card.findByRole("alert");

    await userEvent.click(card.getByRole("button", { name: "Mark False positive" }));
    await userEvent.type(card.getByRole("textbox", { name: "Reason" }), "A test fixture");
    await userEvent.click(card.getByRole("button", { name: "Mark False positive" }));
    expect(await card.findByText("Marked a False positive.")).toHaveFocus();
  });
});
