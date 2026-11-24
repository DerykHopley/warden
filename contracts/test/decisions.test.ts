import { describe, expect, it } from "vitest";
import {
  AcceptBody,
  HistoryBody,
  HistoryEntryBody,
  MarkMovedBody,
  ReasonBody,
} from "../src/index.ts";
import { expectRefused } from "./refused.ts";

const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();

describe("the decision bodies", () => {
  it("accept a reason, with an until on AcceptBody and a candidate on MarkMovedBody", () => {
    const until = tomorrow();
    expect(AcceptBody.parse({ reason: "Fixed next sprint", until })).toEqual({
      reason: "Fixed next sprint",
      until,
    });
    expect(ReasonBody.parse({ reason: "A test fixture" })).toEqual({ reason: "A test fixture" });
    expect(MarkMovedBody.parse({ reason: "Moved", candidate: "f-2" })).toEqual({
      reason: "Moved",
      candidate: "f-2",
    });
  });

  it.each([
    ["a blank reason", { reason: " \n\t" }],
    ["an empty reason", { reason: "" }],
    ["a 2,001-character reason", { reason: "x".repeat(2001) }],
    ["no reason", {}],
  ])("refuse %s", (_name, body) => {
    expectRefused(ReasonBody, body, "reason");
  });

  it("take a 2,000-character reason", () => {
    expect(ReasonBody.safeParse({ reason: "x".repeat(2000) }).success).toBe(true);
  });

  it.each([
    ["an actor", ReasonBody, { reason: "r", actor: { kind: "person", id: "user_x" } }, "actor"],
    ["a team", AcceptBody, { reason: "r", until: tomorrow(), team: "org_other" }, "team"],
  ] as const)("refuse %s as an unknown key", (_name, schema, body, key) => {
    expectRefused(schema, body, key);
  });

  it.each([
    ["now", () => new Date().toISOString()],
    ["an hour ago", () => new Date(Date.now() - 3600 * 1000).toISOString()],
    ["not a date-time", () => "next week"],
  ])("AcceptBody refuses an until of %s", (_name, until) => {
    expectRefused(AcceptBody, { reason: "r", until: until() }, "until");
  });

  it("MarkMovedBody refuses no candidate", () => {
    expectRefused(MarkMovedBody, { reason: "r" }, "candidate");
  });
});

describe("HistoryBody", () => {
  const entry = {
    at: "2026-11-24T10:00:00.123Z",
    status_before: "open",
    status_after: "accepted",
    severity_before: "high",
    severity_after: "high",
    cause: { kind: "person", id: "user_lead" },
    reason: "Fixed next sprint",
  };

  it("takes a person's entry and an opening entry", () => {
    const opened = {
      ...entry,
      status_before: null,
      severity_before: null,
      cause: { kind: "scan", id: "scan-1" },
    };
    expect(HistoryBody.parse({ history: [opened, entry] })).toEqual({ history: [opened, entry] });
  });

  it("refuses an agent as the cause", () => {
    expectRefused(HistoryEntryBody, { ...entry, cause: { kind: "agent", id: "a-1" } }, "kind");
  });
});
