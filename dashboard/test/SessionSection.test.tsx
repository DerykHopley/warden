// The detail card's Session section (spec #225, slice 9a, story 9): an Agent session Finding's evidence, from the
// Finding alone: the hash of every event the Judge read, how many it read and relied on, and each event it relied on,
// with its place, time, name, tool and text. It renders SessionSection alone; that only an Agent session's card holds
// it is DetailCard.test.tsx's.
import { render, screen, within } from "@testing-library/react";
import { SessionEvidence, type MaskedAgentEvent } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { dayAndTimeWords } from "../src/date-words.ts";
import { SessionSection } from "../src/SessionSection.tsx";

const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;

const EVENTS: MaskedAgentEvent[] = [
  { seq: 3, at: "2026-11-24T10:00:00.000Z", name: "PreToolUse", tool: "Bash", text: "cat .env" },
  { seq: 9, at: "2026-11-24T10:02:30.000Z", name: "UserPromptSubmit", text: "ship it" },
];

/** A valid SessionEvidence, as the Finding holds it; `fields` changes it. */
const evidence = (fields: Partial<SessionEvidence> = {}): SessionEvidence =>
  SessionEvidence.parse({ events: EVENTS, events_read: 42, events_hash: HASH, ...fields });

function show(session: SessionEvidence) {
  const { container } = render(<SessionSection session={session} />);
  return { section: within(screen.getByRole("region", { name: "Session" })), container };
}

/** The kept events, one list item each, in the order shown. */
const items = (section: ReturnType<typeof show>["section"]) =>
  within(section.getByRole("list")).getAllByRole("listitem");

describe("the detail card's Session section", () => {
  it("shows the events hash in full in mono, under the heading Session", () => {
    const { section } = show(evidence());
    expect(screen.getByRole("heading", { level: 4, name: "Session" })).toBeVisible();
    const hash = section.getByText(HASH);
    expect(hash.tagName).toBe("CODE");
  });

  it("says how many events the Judge read and relied on, then each kept event's place, time, name, tool and text, in seq order", () => {
    const { section } = show(evidence());
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
    const { section } = show(evidence());
    const times = items(section).map((item) => item.querySelector("time"));
    expect(times.map((time) => time?.dateTime)).toEqual(EVENTS.map((event) => event.at));
    expect(times.map((time) => time?.textContent)).toEqual(
      EVENTS.map((event) => dayAndTimeWords(event.at)),
    );
  });
});
