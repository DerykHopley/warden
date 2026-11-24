import { describe, expect, it } from "vitest";
import { ReconcileCase } from "../src/index.ts";
import { finding, lead, observation, repo, scan, spotRun, validCase } from "./fixtures.ts";
import { expectIssueAt, expectRefused } from "./refused.ts";

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

  it.each([" ", "\t", "\n", " \t\r\n "])(
    "refuses a decision whose reason is only whitespace (%j)",
    (reason) => {
      expectRefused(ReconcileCase, withStep(1, decision({ reason })), "reason");
    },
  );

  it("refuses an expected Finding whose title is only whitespace", () => {
    expectRefused(
      ReconcileCase,
      validCase({ expect: [{ id: "f-1", title: " \t" }, { new: "moved" }] }),
      "title",
    );
  });

  describe("refuses two labels on one problem: the same Asset, module and Fingerprint", () => {
    const moved = observation({ location: { kind: "file", path: ".claude/settings.local.json" } });
    const movedAgain = observation({
      location: { kind: "file", path: ".claude/settings.local.json", line: 40 },
    });
    const labelled = (step: Record<string, unknown>) => {
      const value = validCase();
      value.steps[2] = step as (typeof value.steps)[number];
      value.expect = [{ id: "f-1" }, { new: "moved" }, { new: "again" }] as typeof value.expect;
      return value;
    };

    it("in a later Scan", () => {
      const value = labelled({
        step: "scan",
        scan: scan({ id: "scan-2", observations: [movedAgain] }),
        labels: { again: 0 },
      });
      expectIssueAt(ReconcileCase, value, ["steps", 2, "labels", "again"], /"moved"/);
    });

    it("in a Spot run", () => {
      const value = labelled({
        step: "spot_run",
        spot_run: spotRun({ id: "spot-2", observations: [moved] }),
        labels: { again: 0 },
      });
      expectIssueAt(ReconcileCase, value, ["steps", 2, "labels", "again"], /"moved"/);
    });

    it("but accepts labels on the same Fingerprint on another Asset", () => {
      const api = { kind: "repo", ref: "https://github.com/example/api" };
      const onApi = labelled({
        step: "scan",
        scan: scan({ id: "scan-2", assets: [api], observations: [{ ...moved, asset: api }] }),
        labels: { again: 0 },
      });
      expect(ReconcileCase.safeParse(onApi).success).toBe(true);
    });
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

  it("refuses two labels on the same Observation in one step", () => {
    const two = scan({
      observations: [
        observation(),
        observation({ location: { kind: "file", path: ".claude/settings.local.json" } }),
      ],
    });
    const value = withStep(0, { step: "scan", scan: two, labels: { moved: 0, again: 0 } });
    expectRefused(ReconcileCase, value, "again");
  });

  it("refuses a mark_moved whose candidate is the Finding itself", () => {
    expectRefused(
      ReconcileCase,
      withStep(1, decision({ decision: "mark_moved", candidate: { id: "f-1" } })),
      "candidate",
    );
  });

  describe("an expectation holds the Finding rules among the fields it gives", () => {
    const expecting = (fields: Record<string, unknown>) =>
      validCase({ expect: [{ id: "f-1", ...fields }, { new: "moved" }] });

    it("accepts a partial expectation that leaves the paired fields out", () => {
      expect(ReconcileCase.safeParse(expecting({ status: "accepted" })).success).toBe(true);
      expect(ReconcileCase.safeParse(expecting({ module: "patch" })).success).toBe(true);
    });

    it("refuses a Rule of another module", () => {
      expectRefused(
        ReconcileCase,
        expecting({ module: "patch", rule_id: "guard/agent-can-read-env" }),
        "rule_id",
      );
    });

    it("refuses a session Location on a Repo, and a Fingerprint that doesn't fit", () => {
      expectRefused(
        ReconcileCase,
        expecting({ asset: repo, location: { kind: "session" } }),
        "location",
      );
      expectRefused(
        ReconcileCase,
        expecting({
          rule_id: "guard/agent-can-read-env",
          location: { kind: "file", path: ".env" },
          fingerprint: "guard/agent-can-read-env|file:other",
        }),
        "fingerprint",
      );
    });

    it("refuses lifecycle fields that don't fit the status", () => {
      expectRefused(
        ReconcileCase,
        expecting({ status: "accepted", accepted_reason: null }),
        "accepted_reason",
      );
      expectRefused(
        ReconcileCase,
        expecting({ status: "open", accepted_until: "2027-01-01T00:00:00Z" }),
        "accepted_until",
      );
      expectRefused(
        ReconcileCase,
        expecting({ status: "open", unconfirmed_fix: { candidates: [{ new: "moved" }] } }),
        "unconfirmed_fix",
      );
      expectRefused(
        ReconcileCase,
        expecting({ status: "open", moved_to: { new: "moved" } }),
        "moved_to",
      );
      expectRefused(
        ReconcileCase,
        expecting({ status: "fixed", moved_to: { id: "f-1" } }),
        "moved_to",
      );
    });
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
