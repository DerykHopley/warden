import { describe, expect, it } from "vitest";
import { ScanBody, ScanState, StartScanBody } from "../src/index.ts";
import { expectIssueAt, expectRefused } from "./refused.ts";

const repo = (n: number) => ({ kind: "repo", ref: `https://github.com/example/app-${n}` }) as const;

describe("StartScanBody", () => {
  it("takes a module and 1 to 100 Assets", () => {
    const one = { module: "guard", assets: [repo(1)] };
    const hundred = { module: "guard", assets: Array.from({ length: 100 }, (_, i) => repo(i)) };

    expect(StartScanBody.parse(one)).toEqual(one);
    expect(StartScanBody.parse(hundred)).toEqual(hundred);
  });

  it.each([
    ["an unknown module", { module: "audit", assets: [repo(1)] }, "module"],
    ["no Assets", { module: "guard", assets: [] }, "assets"],
    [
      "101 Assets",
      { module: "guard", assets: Array.from({ length: 101 }, (_, i) => repo(i)) },
      "assets",
    ],
    [
      "Rules, which come from the scanner",
      { module: "guard", assets: [repo(1)], rules: [] },
      "rules",
    ],
    [
      "a Team, which comes from the session",
      { module: "guard", assets: [repo(1)], team: "t" },
      "team",
    ],
  ])("refuses %s", (_name, body, field) => {
    expectRefused(StartScanBody, body, field);
  });

  it("refuses an Asset listed twice, on the later one", () => {
    expectIssueAt(
      StartScanBody,
      { module: "guard", assets: [repo(1), repo(2), repo(1)] },
      ["assets", 2],
      /assets\[0\]/,
    );
  });

  it("refuses an Agent session, as a Scan does", () => {
    expectIssueAt(
      StartScanBody,
      { module: "guard", assets: [repo(1), { kind: "agent_session", ref: "s-1" }] },
      ["assets", 1],
      /never rescanned/,
    );
  });
});

describe("ScanBody", () => {
  const queued = {
    id: "scan-1",
    module: "guard",
    state: "queued",
    assets: [repo(1)],
    rules: ["guard/agent-can-read-env"],
    queued_at: "2026-11-25T09:00:00.000Z",
    started_at: null,
    ended_at: null,
  };

  it("reads a queued Scan, its later times null", () => {
    expect(ScanBody.parse(queued)).toEqual(queued);
  });

  it("takes each of the four states", () => {
    expect(ScanState.options).toEqual(["queued", "running", "done", "failed"]);
  });

  it("refuses a state outside the four", () => {
    expectRefused(ScanBody, { ...queued, state: "cancelled" }, "state");
  });

  it("names no Team and no person: they stay on the server", () => {
    expectRefused(ScanBody, { ...queued, team: "org_a" }, "team");
    expectRefused(ScanBody, { ...queued, requested_by: "user_a" }, "requested_by");
  });
});
