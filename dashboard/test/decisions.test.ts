// The detail card's Until (story 4): the earliest day a person may pick, and the end of the picked day in their own
// time zone, as an AcceptBody or ProposeBody sends it. What the card sends and shows is DetailCard.test.tsx's.
import { AcceptBody } from "@warden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { endOfDay, earliestUntil } from "../src/decisions.ts";

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("endOfDay", () => {
  it.each([
    ["America/New_York", "2026-12-01", "2026-12-01T23:59:59.999-05:00"],
    ["America/New_York", "2027-07-01", "2027-07-01T23:59:59.999-04:00"],
    ["Asia/Kolkata", "2026-12-01", "2026-12-01T23:59:59.999+05:30"],
    ["UTC", "2026-12-01", "2026-12-01T23:59:59.999+00:00"],
  ])("in %s, ends %s at %s, with its offset", (tz, day, until) => {
    process.env.TZ = tz;
    expect(endOfDay(day)).toBe(until);
    expect(AcceptBody.shape.until.safeParse(until).success).toBe(true);
  });
});

describe("earliestUntil", () => {
  it("is the day after today in the person's time zone, as a date input's value", () => {
    process.env.TZ = "Asia/Kolkata";
    // 20:00 UTC on Nov 30 is already Dec 1 in Kolkata, so the earliest Until is Dec 2.
    expect(earliestUntil(new Date("2026-11-30T20:00:00Z"))).toBe("2026-12-02");
    expect(earliestUntil(new Date("2026-12-31T10:00:00Z"))).toBe("2027-01-01");
  });
});
