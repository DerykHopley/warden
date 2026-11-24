import { describe, expect, it } from "vitest";
import { ReconcileCase } from "../src/index.ts";
import { finding, lead, scan, validCase } from "./fixtures.ts";
import { expectRefused } from "./refused.ts";

function withStep(index: number, step: Record<string, unknown>) {
  const value = validCase();
  value.steps[index] = step as (typeof value.steps)[number];
  return value;
}

const decision = (fields: Record<string, unknown>) => ({
  step: "decision",
  decision: "confirm_fix",
  finding: { id: "f-1" },
  actor: lead,
  reason: "Checked by hand",
  ...fields,
});

describe("ReconcileCase", () => {
  it("parses a valid case", () => {
    expect(ReconcileCase.safeParse(validCase()).success).toBe(true);
  });

  it("parses every decision, with until only on accept and candidate only on mark_moved", () => {
    for (const name of ["mark_false_positive", "confirm_fix", "reopen"]) {
      expect(ReconcileCase.safeParse(withStep(1, decision({ decision: name }))).success).toBe(true);
    }
    expect(
      ReconcileCase.safeParse(
        withStep(1, decision({ decision: "mark_moved", candidate: { new: "moved" } })),
      ).success,
    ).toBe(true);
  });

  it("refuses a decision by an agent: agents only propose", () => {
    expectRefused(
      ReconcileCase,
      withStep(1, decision({ actor: { kind: "agent", id: "judge" } })),
      "actor",
    );
  });

  it("refuses accept without until, until on another decision, and mark_moved without candidate", () => {
    expectRefused(ReconcileCase, withStep(1, decision({ decision: "accept" })), "until");
    expectRefused(ReconcileCase, withStep(1, decision({ until: "2027-01-01T00:00:00Z" })), "until");
    expectRefused(ReconcileCase, withStep(1, decision({ decision: "mark_moved" })), "candidate");
    expectRefused(ReconcileCase, withStep(1, decision({ candidate: { id: "f-1" } })), "candidate");
  });

  it("refuses a decision without a reason", () => {
    expectRefused(ReconcileCase, withStep(1, decision({ reason: "" })), "reason");
  });

  it("refuses a reference to a label no earlier step created", () => {
    expectRefused(
      ReconcileCase,
      withStep(1, decision({ finding: { new: "elsewhere" } })),
      "finding",
    );
    expectRefused(
      ReconcileCase,
      validCase({ expect: [{ id: "f-1" }, { new: "elsewhere" }] }),
      "new",
    );
    expectRefused(
      ReconcileCase,
      validCase({
        expect: [
          { id: "f-1", unconfirmed_fix: { candidates: [{ new: "elsewhere" }] } },
          { new: "moved" },
        ],
      }),
      "candidates",
    );
    // A label used before the step that creates it.
    const early = validCase();
    early.steps = [early.steps[1]!, early.steps[0]!, early.steps[2]!];
    expectRefused(ReconcileCase, early, "finding");
  });

  it("refuses a reference to an id that isn't in given", () => {
    expectRefused(ReconcileCase, withStep(1, decision({ finding: { id: "f-9" } })), "finding");
    expectRefused(ReconcileCase, validCase({ expect: [{ id: "f-9" }, { new: "moved" }] }), "id");
  });

  it("refuses a label on an Observation the step doesn't have, and a label used twice", () => {
    expectRefused(
      ReconcileCase,
      withStep(0, { ...validCase().steps[0]!, labels: { moved: 1 } }),
      "moved",
    );
    const twice = validCase();
    twice.steps[2] = {
      ...twice.steps[0]!,
      scan: scan({ id: "scan-2" }),
      labels: { moved: 0 },
    } as (typeof twice.steps)[number];
    expectRefused(ReconcileCase, twice, "moved");
  });

  it("refuses an expectation naming a Finding twice, or with both an id and a label", () => {
    expectRefused(
      ReconcileCase,
      validCase({ expect: [{ id: "f-1" }, { id: "f-1" }, { new: "moved" }] }),
      "id",
    );
    expectRefused(ReconcileCase, validCase({ expect: [{ id: "f-1", new: "moved" }] }), "expect");
  });

  it("refuses an unknown step, an unknown field on an expectation, and a given Finding that isn't valid", () => {
    expectRefused(ReconcileCase, withStep(2, { step: "rescan" }), "step");
    expectRefused(
      ReconcileCase,
      validCase({ expect: [{ id: "f-1", colour: "red" }, { new: "moved" }] }),
      "colour",
    );
    expectRefused(
      ReconcileCase,
      validCase({
        given: { now: "2026-11-24T08:00:00Z", findings: [finding({ status: "done" })] },
      }),
      "status",
    );
  });
});
