// The detail card's Until (story 4): the earliest day a person may pick, and the start of the picked day in their own
// time zone, as an AcceptBody or ProposeBody sends it. What the card sends and shows is DetailCard.test.tsx's.
import { AcceptBody } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayWords } from "../src/date-words.ts";
import { earliestUntil, startOfDay } from "../src/decisions.ts";

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("startOfDay", () => {
  // AcceptBody's until must be later than now: a fixed now keeps these fixed days valid whenever the test runs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["America/New_York", "2027-12-01", "2027-12-01T00:00:00.000-05:00"],
    ["America/New_York", "2027-07-01", "2027-07-01T00:00:00.000-04:00"],
    ["Asia/Kolkata", "2027-12-01", "2027-12-01T00:00:00.000+05:30"],
    ["UTC", "2027-12-01", "2027-12-01T00:00:00.000+00:00"],
    ["Pacific/Honolulu", "2027-01-15", "2027-01-15T00:00:00.000-10:00"],
    ["Pacific/Kiritimati", "2027-01-15", "2027-01-15T00:00:00.000+14:00"],
    // Chile's clocks skip from 00:00 to 01:00 on this day: it starts at 01:00.
    ["America/Santiago", "2027-09-05", "2027-09-05T01:00:00.000-03:00"],
  ])("in %s, starts %s at %s, with its offset", (tz, day, until) => {
    process.env.TZ = tz;
    expect(startOfDay(day)).toBe(until);
    expect(AcceptBody.shape.until.safeParse(until).success).toBe(true);
  });

  it.each(["Pacific/Honolulu", "UTC", "Pacific/Kiritimati", "America/Santiago"])(
    "in %s, reads back as the picked day once the server has it in UTC",
    (tz) => {
      process.env.TZ = tz;
      const stored = new Date(startOfDay("2027-09-05")).toISOString();
      expect(dayWords(stored)).toBe("Sep 5, 2027");
    },
  );
});

describe("earliestUntil", () => {
  it("is the day after today in the person's time zone, as a date input's value", () => {
    process.env.TZ = "Asia/Kolkata";
    // 20:00 UTC on Nov 30 is already Dec 1 in Kolkata, so the earliest Until is Dec 2.
    expect(earliestUntil(new Date("2026-11-30T20:00:00Z"))).toBe("2026-12-02");
    expect(earliestUntil(new Date("2026-12-31T10:00:00Z"))).toBe("2027-01-01");
  });
});
