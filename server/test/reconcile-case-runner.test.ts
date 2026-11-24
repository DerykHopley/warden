// The runner's skip rule: only a case with a decision or expire step (slice 8) waits; any other case runs.
import { loadReconcileCases } from "@warden/contracts/reconcile-cases";
import { describe, expect, it } from "vitest";
import { planCase, withTeamId } from "./reconcile-case-runner.ts";

const cases = new Map(loadReconcileCases().map(({ file, case: c }) => [file.slice(0, 2), c]));

describe("planCase", () => {
  it("lists cases 10, 15 and 16 as todo, naming slice 8, and runs the other 18", () => {
    const todo = [...cases].filter(([, c]) => !planCase(c).run).map(([number]) => number);
    expect(todo).toEqual(["10", "15", "16"]);
    expect(planCase(cases.get("10")!)).toEqual({
      run: false,
      todo: "needs slice 8 for its expire step",
    });
    expect(planCase(cases.get("15")!)).toMatchObject({ todo: expect.stringMatching(/slice 8/) });
  });

  it("runs case 10 once its expire step is gone", () => {
    const case10 = cases.get("10")!;
    const withoutExpire = { ...case10, steps: case10.steps.filter((s) => s.step !== "expire") };
    expect(planCase(withoutExpire)).toEqual({ run: true });
  });

  it("runs case 15 once its decision step is gone", () => {
    const case15 = cases.get("15")!;
    const withoutDecision = {
      ...case15,
      steps: case15.steps.filter((s) => s.step !== "decision"),
    };
    expect(planCase(withoutDecision)).toEqual({ run: true });
  });
});

describe("withTeamId", () => {
  it("sets every team field, nested in given, steps and expect, and nothing else", () => {
    const changed = withTeamId(cases.get("01")!, "org_case_x");
    const text = JSON.stringify(changed);
    expect(text).not.toContain('"team-a"');
    expect(text.match(/"team":"org_case_x"/g)).toHaveLength(2);
    expect(changed.steps[0]).toMatchObject({ scan: { id: "scan-1", team: "org_case_x" } });
  });
});
