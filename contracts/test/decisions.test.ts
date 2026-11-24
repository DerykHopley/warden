import { describe, expect, it } from "vitest";
import {
  AcceptBody,
  HistoryBody,
  HistoryEntryBody,
  MarkMovedBody,
  Proposal,
  ProposeBody,
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
    proposal: null,
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

  it("takes the daily Job as a cause", () => {
    const expired = { ...entry, cause: { kind: "job", id: "daily-expiry" } };
    expect(HistoryEntryBody.parse(expired)).toEqual(expired);
  });

  it("takes the Proposal a person's decision approved, with an agent as who asked", () => {
    const approved = {
      ...entry,
      proposal: { id: "p-1", requested_by: { kind: "agent", id: "guard-bot" } },
    };
    expect(HistoryEntryBody.parse(approved)).toEqual(approved);
  });

  it("refuses an entry without its proposal field", () => {
    const withoutProposal: Record<string, unknown> = { ...entry };
    delete withoutProposal.proposal;
    expectRefused(HistoryEntryBody, withoutProposal, "proposal");
  });
});

describe("ProposeBody", () => {
  it("takes an accept with a later until, and a mark_false_positive without one", () => {
    const until = tomorrow();
    expect(ProposeBody.parse({ decision: "accept", reason: "Next sprint", until })).toEqual({
      decision: "accept",
      reason: "Next sprint",
      until,
    });
    expect(ProposeBody.parse({ decision: "mark_false_positive", reason: "A fixture" })).toEqual({
      decision: "mark_false_positive",
      reason: "A fixture",
    });
  });

  it.each([
    ["an accept without until", { decision: "accept", reason: "r" }, "until"],
    [
      "a mark_false_positive with until",
      { decision: "mark_false_positive", reason: "r", until: tomorrow() },
      "until",
    ],
    [
      "an until in the past",
      {
        decision: "accept",
        reason: "r",
        until: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
      "until",
    ],
    ["a decision of reopen", { decision: "reopen", reason: "r" }, "decision"],
    ["a blank reason", { decision: "mark_false_positive", reason: "  " }, "reason"],
    [
      "an actor",
      { decision: "mark_false_positive", reason: "r", actor: { kind: "agent", id: "a" } },
      "actor",
    ],
  ])("refuses %s", (_name, body, field) => {
    expectRefused(ProposeBody, body, field);
  });
});

describe("Proposal", () => {
  const proposal = {
    id: "p-1",
    finding_id: "f-1",
    decision: "accept",
    reason: "Next sprint",
    until: "2026-12-01T00:00:00Z",
    requested_by: { kind: "person", id: "user_member" },
    requested_at: "2026-11-24T10:00:00Z",
    state: "pending",
    decided_by: null,
    decided_at: null,
    decided_reason: null,
  };

  it("takes a pending Proposal and a rejected one, an until in the past included", () => {
    const rejected = {
      ...proposal,
      until: "2020-01-01T00:00:00Z",
      state: "rejected",
      decided_by: "user_lead",
      decided_at: "2026-11-24T11:00:00Z",
      decided_reason: "Fix it now",
    };
    expect(Proposal.parse(proposal)).toEqual(proposal);
    expect(Proposal.parse(rejected)).toEqual(rejected);
  });

  it("refuses a state it doesn't know", () => {
    expectRefused(Proposal, { ...proposal, state: "withdrawn" }, "state");
  });
});
