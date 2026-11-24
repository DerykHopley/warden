// The Overview's rules below the page (story 10): each journey card's state from the Team's Level, Quick's bar and
// next step from its latest Scan, and the trend line's four wordings.
import type { OverviewBody } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { journeyCards, trendLine } from "../src/overview.ts";

const SCANNED = "2026-11-24T09:14:00Z";
const scannedOn = new Date(SCANNED).toLocaleDateString(undefined, { dateStyle: "medium" });

describe("journeyCards", () => {
  it("at Quick: Quick current, then Standard and Audit-ready not started", () => {
    expect(journeyCards("quick", SCANNED).map((card) => [card.word, card.state])).toEqual([
      ["Quick", "current"],
      ["Standard", "not-started"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("at Standard: Quick done, Standard current, Audit-ready not started", () => {
    expect(journeyCards("standard", SCANNED).map((card) => [card.word, card.state])).toEqual([
      ["Quick", "done"],
      ["Standard", "current"],
      ["Audit-ready", "not-started"],
    ]);
  });

  it("says what each Level adds", () => {
    expect(journeyCards("quick", null).map((card) => card.adds)).toEqual([
      "Repo scan and top fixes",
      "Agent hook and the Judge",
      "Evidence for an audit",
    ]);
  });

  it("before the first Scan, Quick's bar is empty and its next step is the first Scan", () => {
    const [quick] = journeyCards("quick", null);
    expect(quick).toMatchObject({ progress: 0, notes: ["Next: the first Scan"] });
  });

  it("after a Scan, Quick's bar is full, with the Scan's date and Standard as the next step", () => {
    const [quick] = journeyCards("quick", SCANNED);
    expect(quick).toMatchObject({
      progress: 100,
      notes: [`Last Scan: ${scannedOn}`, "Next: Standard adds the agent hook and the Judge"],
    });
  });

  it("gives a done Level a full bar, and a Level not started an empty one", () => {
    const [quick, standard, auditReady] = journeyCards("standard", SCANNED);
    expect(quick!.progress).toBe(100);
    expect(standard!.progress).toBe(0);
    expect(auditReady!.progress).toBe(0);
  });
});

const body = (fields: Partial<OverviewBody>): OverviewBody => ({
  team: "org_a",
  level: "quick",
  last_scan_at: SCANNED,
  has_findings: true,
  period_days: 30,
  open_at_start: 0,
  open_now: 7,
  fix_rate: { fixed: 1, of: 11 },
  ...fields,
});

const nothingCounted = { open_at_start: 0, open_now: 0, fix_rate: { fixed: 0, of: 0 } };

describe("trendLine", () => {
  it("says where Open Findings went, and the fix rate as a whole percent", () => {
    expect(trendLine(body({}))).toBe("Open Findings went from 0 to 7 in 30 days; fix rate 9%.");
  });

  it("says Open Findings stayed when the count didn't change", () => {
    expect(trendLine(body({ open_at_start: 7 }))).toBe(
      "Open Findings stayed at 7 over 30 days; fix rate 9%.",
    );
  });

  it("rounds the rate down, so 199 of 200 is 99%, never a 100% that isn't", () => {
    expect(trendLine(body({ fix_rate: { fixed: 199, of: 200 } }))).toBe(
      "Open Findings went from 0 to 7 in 30 days; fix rate 99%.",
    );
  });

  it("shows at least 1% when any was fixed: 1 of 300 is 1%", () => {
    expect(trendLine(body({ fix_rate: { fixed: 1, of: 300 } }))).toBe(
      "Open Findings went from 0 to 7 in 30 days; fix rate 1%.",
    );
  });

  it("drops the fix rate when nothing was there to fix", () => {
    expect(trendLine(body(nothingCounted))).toBe("Open Findings stayed at 0 over 30 days.");
  });

  it("with Findings that all stay out of the counts (Accepted and old) and no Scan, still gives the trend", () => {
    expect(trendLine(body({ ...nothingCounted, last_scan_at: null }))).toBe(
      "Open Findings stayed at 0 over 30 days.",
    );
  });

  it("with no Findings and no Scan, says the trend starts after the first Scan", () => {
    expect(trendLine(body({ ...nothingCounted, has_findings: false, last_scan_at: null }))).toBe(
      "No Findings yet: the trend starts after the first Scan.",
    );
  });
});
