// The detail card's Session section (spec #225, slices 9a and 9b, story 9): an Agent session Finding's evidence, from
// the Finding alone: the hash of every event the Judge read, how many it read and relied on, and each event it relied
// on, with its place, time, name, tool and text. Above them, the session's record, asked of
// `GET /api/guard/findings/:id/session` once /api/me says the session is in the Finding's Team: the developer's
// pseudonym and when the session started, ended and was judged. It renders SessionSection alone, Warden's server faked;
// that only an Agent session's card holds it is DetailCard.test.tsx's.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AgentSessionBody,
  SessionEvidence,
  type Finding,
  type MaskedAgentEvent,
} from "@warden/contracts";
import { DEMO_OBSERVATIONS } from "@warden/contracts/demo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAndTimeWords } from "../src/date-words.ts";
import { SessionSection } from "../src/SessionSection.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { finding, TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;

const EVENTS: MaskedAgentEvent[] = [
  { seq: 3, at: "2026-11-24T10:00:00.000Z", name: "PreToolUse", tool: "Bash", text: "cat .env" },
  { seq: 9, at: "2026-11-24T10:02:30.000Z", name: "UserPromptSubmit", text: "ship it" },
];

/** A valid SessionEvidence, as the Finding holds it; `fields` changes it. */
const evidence = (fields: Partial<SessionEvidence> = {}): SessionEvidence =>
  SessionEvidence.parse({ events: EVENTS, events_read: 42, events_hash: HASH, ...fields });

const ID = "7c1e5a90-0000-4000-8000-000000000001";
const OTHER_ID = "7c1e5a90-0000-4000-8000-000000000002";
const SESSION_PATH = `/api/guard/findings/${ID}/session`;

/** An Agent session Finding, as the Judge opens one. */
const SESSION_FINDING = (id = ID): Finding => {
  const { asset, location, rule_id, title } = DEMO_OBSERVATIONS.printed;
  return finding(id, { asset, location, rule_id, title, evidence: { summary: "s" } });
};

const PSEUDONYM = "a3f9c27e1b04d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0";

/** A valid session record, as the route answers it; `fields` changes it. */
const record = (fields: Partial<AgentSessionBody> = {}): AgentSessionBody =>
  AgentSessionBody.parse({
    developer: PSEUDONYM,
    started_at: "2026-11-24T09:58:00.000Z",
    ended_at: "2026-11-24T10:05:00.000Z",
    judged_at: "2026-11-24T10:06:12.000Z",
    ...fields,
  });

/** /api/me's answer: the session is in `team`. */
const meIn = (team: string) =>
  json(200, { userId: "user_me", team, role: "member", level: "quick" });

const onSessionEnded = vi.fn();
const sessionToken = () => Promise.resolve("session-token" as string | null);

/**
 * Renders the section for `session` on the Agent session Finding, with the server's routes `routes` (/api/me says the
 * session is in the Finding's Team, and the record answers, unless `routes` says otherwise).
 */
function show(
  session: SessionEvidence = evidence(),
  routes: Routes = {},
  getToken: () => Promise<string | null> = sessionToken,
) {
  onSessionEnded.mockReset();
  serve({ me: () => meIn(TEAM), sessionRecord: () => json(200, record()), ...routes });
  const element = (shown: Finding) => (
    <SessionSection
      finding={shown}
      session={session}
      getToken={getToken}
      onSessionEnded={onSessionEnded}
    />
  );
  const { container, rerender } = render(element(SESSION_FINDING()));
  return {
    section: within(screen.getByRole("region", { name: "Session" })),
    container,
    /** The section again, for another Finding, as a new focus hands it. */
    update: (shown: Finding) => rerender(element(shown)),
  };
}

type Section = ReturnType<typeof show>["section"];

/** The section's "Session" heading. */
const heading = () => screen.getByRole("heading", { level: 4, name: "Session" });

/** A button outside the section, as the card's Decisions or the chat would be, focused. */
function focusedElsewhere() {
  const elsewhere = document.createElement("button");
  elsewhere.type = "button";
  elsewhere.textContent = "Elsewhere";
  document.body.append(elsewhere);
  elsewhere.focus();
  return elsewhere;
}
afterEach(() => {
  for (const button of document.querySelectorAll("body > button")) button.remove();
});

/** The kept events, one list item each, in the order shown. */
const items = (section: Section) => within(section.getByRole("list")).getAllByRole("listitem");

/** The section's rows once the record has shown: each label and its value's element. */
async function rows(section: Section) {
  await section.findByText("Developer");
  return Object.fromEntries(
    section.getAllByRole("term").map((term) => [term.textContent, term.nextElementSibling]),
  ) as Record<string, HTMLElement | undefined>;
}

describe("the detail card's Session section", () => {
  it("shows the events hash in full in mono, under the heading Session", () => {
    const { section } = show();
    expect(screen.getByRole("heading", { level: 4, name: "Session" })).toBeVisible();
    const hash = section.getByText(HASH);
    expect(hash.tagName).toBe("CODE");
  });

  it("says how many events the Judge read and relied on, then each kept event's place, time, name, tool and text, in seq order", () => {
    const { section } = show();
    expect(section.getByText("The Judge read 42 events and relied on these 2.")).toBeVisible();

    const [first, second] = items(section);
    expect(items(section)).toHaveLength(2);
    const one = within(first!);
    expect(one.getByText("Event 4")).toBeVisible();
    expect(one.getByText(dayAndTimeWords(EVENTS[0]!.at))).toBeVisible();
    expect(one.getByText("PreToolUse")).toBeVisible();
    expect(one.getByText("Bash")).toBeVisible();
    expect(one.getByText("cat .env").tagName).toBe("PRE");

    const two = within(second!);
    expect(two.getByText("Event 10")).toBeVisible();
    expect(two.getByText(dayAndTimeWords(EVENTS[1]!.at))).toBeVisible();
    expect(two.getByText("UserPromptSubmit")).toBeVisible();
    expect(two.getByText("ship it").tagName).toBe("PRE");
    // An event with no tool names none: only its place, time, name and text.
    expect(second!.querySelectorAll(".session-event-tool")).toHaveLength(0);
  });

  it("says the singular words for one event read and one relied on", () => {
    const { section } = show(evidence({ events: [{ ...EVENTS[0]!, seq: 0 }], events_read: 1 }));
    expect(section.getByText("The Judge read 1 event and relied on this 1.")).toBeVisible();
  });

  it("says this 1 for one event relied on out of several read", () => {
    const { section } = show(evidence({ events: [EVENTS[0]!] }));
    expect(section.getByText("The Judge read 42 events and relied on this 1.")).toBeVisible();
  });

  it("shows an event's markup and line break as literal text over two lines, with no img in the section", () => {
    const text = "<img src=x onerror=alert(1)>\nsecond line";
    const { section, container } = show(evidence({ events: [{ ...EVENTS[0]!, text }] }));
    const shown = section.getByText((_, element) => element?.tagName === "PRE");
    expect(shown.textContent).toBe(text);
    expect(shown.textContent!.split("\n")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
  });

  it("gives each event's time as a time element whose dateTime is its at", () => {
    const { section } = show();
    const times = items(section).map((item) => item.querySelector("time"));
    expect(times.map((time) => time?.dateTime)).toEqual(EVENTS.map((event) => event.at));
    expect(times.map((time) => time?.textContent)).toEqual(
      EVENTS.map((event) => dayAndTimeWords(event.at)),
    );
  });
});

describe("the Session section's record", () => {
  it("shows the pseudonym's first 12 hex digits then … in mono, and Started, Ended and Judged as times, above the events hash", async () => {
    const { section } = show();
    const row = await rows(section);

    expect(row.Developer).toHaveTextContent(/^pseudonym a3f9c27e1b04…$/);
    expect(row.Developer!.querySelector("code")).toHaveTextContent(/^a3f9c27e1b04…$/);
    const answer = record();
    for (const [label, at] of [
      ["Started", answer.started_at],
      ["Ended", answer.ended_at!],
      ["Judged", answer.judged_at!],
    ] as const) {
      const time = row[label]!.querySelector("time");
      expect(time?.dateTime, label).toBe(at);
      expect(time).toHaveTextContent(dayAndTimeWords(at));
    }
    const terms = section.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["Developer", "Started", "Ended", "Judged", "Events hash", "Events"]);
  });

  it("reads Not named, Not ended and Not judged for a record with none", async () => {
    const { section } = show(evidence(), {
      sessionRecord: () => json(200, record({ developer: null, ended_at: null, judged_at: null })),
    });
    const row = await rows(section);
    expect(row.Developer).toHaveTextContent(/^Not named$/);
    expect(row.Ended).toHaveTextContent(/^Not ended$/);
    expect(row.Judged).toHaveTextContent(/^Not judged$/);
    expect(row.Ended!.querySelector("time")).toBeNull();
    expect(row.Judged!.querySelector("time")).toBeNull();
  });

  it("shows Loading the session… muted while the record loads, with the hash and events already shown", async () => {
    const held = deferred<Response>();
    const { section } = show(evidence(), { sessionRecord: () => held.promise });
    await vi.waitFor(() => expect(callsTo(SESSION_PATH)).toHaveLength(1));

    expect(section.getByText("Loading the session…")).toHaveClass("muted");
    expect(section.queryByText("Developer")).toBeNull();
    expect(section.getByText(HASH)).toBeVisible();
    expect(items(section)).toHaveLength(2);

    held.resolve(json(200, record()));
    await rows(section);
    expect(section.queryByText("Loading the session…")).toBeNull();
  });

  it("a 404 shows the server's words, muted, with no Retry", async () => {
    const { section } = show(evidence(), {
      sessionRecord: () => json(404, { error: "This Finding isn't on an Agent session" }),
    });
    expect(await section.findByText("This Finding isn't on an Agent session.")).toHaveClass(
      "muted",
    );
    expect(section.queryByRole("button")).toBeNull();
    expect(section.getByText(HASH)).toBeVisible();
  });

  it("a 404 without a body says Warden holds no record of this session.", async () => {
    const { section } = show(evidence(), {
      sessionRecord: () => new Response(null, { status: 404 }),
    });
    expect(await section.findByText("Warden holds no record of this session.")).toHaveClass(
      "muted",
    );
    expect(section.queryByRole("button")).toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 500", () => json(500, { error: "boom" })],
    ["a 403", () => json(403, { error: "no Team" })],
    ["a 409", () => json(409, { error: "not opened" })],
    ["a body that doesn't parse", () => json(200, { ...record(), developer: 7 })],
  ])(
    "%s shows Couldn't load the session. with Retry, busy while it runs; Retry asks again and shows the record",
    async (_, failed) => {
      const again = deferred<Response>();
      const answers = [failed, () => again.promise];
      const { section } = show(evidence(), { sessionRecord: () => answers.shift()!() });
      expect(await section.findByText("Couldn't load the session.")).toHaveClass("muted");

      const retry = section.getByRole("button", { name: "Retry the session" });
      expect(retry).toHaveTextContent(/^Retry$/);
      expect(retry).toHaveClass("secondary");
      await userEvent.click(retry);
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toBeDisabled();
      expect(callsTo(SESSION_PATH)).toHaveLength(2);

      again.resolve(json(200, record()));
      const row = await rows(section);
      expect(row.Developer).toHaveTextContent("a3f9c27e1b04…");
      expect(section.queryByText("Couldn't load the session.")).toBeNull();
      // The button went with the refusal: focus is on the heading, not left on the page.
      expect(heading()).toHaveFocus();
    },
  );

  it("a 429 with Retry-After 30 says to try again in 30 seconds, with Retry", async () => {
    const { section } = show(evidence(), {
      sessionRecord: () => json(429, { error: "slow down" }, { "Retry-After": "30" }),
    });
    expect(
      await section.findByText("Too many sign-in attempts. Try again in 30 seconds."),
    ).toBeVisible();
    expect(section.getByRole("button", { name: "Retry the session" })).toBeVisible();
  });

  it("a 401 ends the session", async () => {
    show(evidence(), { sessionRecord: () => json(401, { error: "signed out" }) });
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it("isn't asked until /api/me says the session is in the Finding's Team, and is asked with that answer's token", async () => {
    let tokens = 0;
    const getTokens = async () => `token-${++tokens}` as string | null;
    const { section } = show(
      evidence(),
      {
        // The first token is for the Team just left; the next is the Finding's.
        me: () => {
          const [, init] = callsTo("/api/me").at(-1)!;
          const token = new Headers(init?.headers).get("Authorization");
          return meIn(token === "Bearer token-1" ? "org_left" : TEAM);
        },
      },
      getTokens,
    );
    await rows(section);

    const meCalls = callsTo("/api/me");
    expect(meCalls).toHaveLength(2);
    const asked = callsTo(SESSION_PATH);
    expect(asked).toHaveLength(1);
    expect(new Headers(asked[0]![1]?.headers).get("Authorization")).toBe("Bearer token-2");
    // Asked after /api/me named the Finding's Team, never before.
    const order = fetchMock.mock.calls.map(([input]) => String(input));
    expect(order.indexOf(SESSION_PATH)).toBeGreaterThan(order.lastIndexOf("/api/me"));
  });

  it("asks again for a new focus, and drops the earlier ask's late answer", async () => {
    const first = deferred<Response>();
    const { section, update } = show(evidence(), {
      sessionRecord: (id) =>
        id === ID ? first.promise : json(200, record({ developer: "b".repeat(64) })),
    });
    await vi.waitFor(() => expect(callsTo(SESSION_PATH)).toHaveLength(1));

    update(SESSION_FINDING(OTHER_ID));
    expect((await rows(section)).Developer).toHaveTextContent("bbbbbbbbbbbb…");

    first.resolve(json(200, record()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await rows(section)).Developer).toHaveTextContent("bbbbbbbbbbbb…");
  });
});

describe("focus after the Session section's Retry", () => {
  /** The section after a 500, its Retry pressed, with Retry's ask answering `again`. */
  async function retried(again: () => Response | Promise<Response>) {
    const answers = [() => json(500, { error: "boom" }), again];
    const shown = show(evidence(), { sessionRecord: () => answers.shift()!() });
    await userEvent.click(await shown.section.findByRole("button", { name: "Retry the session" }));
    return shown;
  }

  it("the Session heading takes focus but stays out of the Tab order", () => {
    show();
    expect(heading()).toHaveAttribute("tabindex", "-1");
  });

  it("a 404 after Retry moves focus to the heading, with the muted line and no Retry", async () => {
    const { section } = await retried(() => new Response(null, { status: 404 }));
    expect(await section.findByText("Warden holds no record of this session.")).toHaveClass(
      "muted",
    );
    expect(section.queryByRole("button")).toBeNull();
    expect(heading()).toHaveFocus();
  });

  it.each<[string, () => Response]>([
    ["a 500", () => json(500, { error: "boom again" })],
    ["a 429", () => json(429, { error: "slow down" }, { "Retry-After": "30" })],
  ])("%s after Retry leaves Retry enabled, not busy, and focused", async (_, again) => {
    const { section } = await retried(again);
    await vi.waitFor(() => expect(callsTo(SESSION_PATH)).toHaveLength(2));
    const retry = section.getByRole("button", { name: "Retry the session" });
    await vi.waitFor(() => expect(retry).toBeEnabled());
    expect(retry).toHaveAttribute("aria-busy", "false");
    expect(retry).toHaveFocus();
  });

  it("focus moved outside the section while Retry's ask runs stays there when the record shows", async () => {
    const again = deferred<Response>();
    const { section } = await retried(() => again.promise);
    const elsewhere = focusedElsewhere();

    again.resolve(json(200, record()));
    await rows(section);
    expect(elsewhere).toHaveFocus();
  });

  it("a new focus while Retry's ask runs: the new Finding's record takes no focus", async () => {
    const again = deferred<Response>();
    const answers = [() => json(500, { error: "boom" }), () => again.promise];
    const { section, update } = show(evidence(), {
      sessionRecord: (id) => (id === ID ? answers.shift()!() : json(200, record())),
    });
    await userEvent.click(await section.findByRole("button", { name: "Retry the session" }));

    update(SESSION_FINDING(OTHER_ID));
    await rows(section);
    again.resolve(json(200, record()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heading()).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it.each<[string, () => Response]>([
    ["the record", () => json(200, record())],
    ["a 404", () => new Response(null, { status: 404 })],
    ["a 500", () => json(500, { error: "boom" })],
  ])("the card's first ask answering %s moves no focus", async (_, answer) => {
    const elsewhere = focusedElsewhere();
    show(evidence(), { sessionRecord: answer });
    await vi.waitFor(() => expect(callsTo(SESSION_PATH)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Loading the session…")).toBeNull();
    expect(elsewhere).toHaveFocus();
  });
});
