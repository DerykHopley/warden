// The runner's skip rule: only a case with an expire step (slice 8b) waits; any other case runs, decisions included.
import { loadReconcileCases } from "@warden/contracts/reconcile-cases";
import { describe, expect, it } from "vitest";
import { planCase, withTeamId } from "./reconcile-case-runner.ts";

const cases = new Map(loadReconcileCases().map(({ file, case: c }) => [file.slice(0, 2), c]));

describe("planCase", () => {
  it("lists only case 10 as todo, naming slice 8b, and runs the other 20", () => {
    const todo = [...cases].filter(([, c]) => !planCase(c).run).map(([number]) => number);
    expect(todo).toEqual(["10"]);
    expect(planCase(cases.get("10")!)).toEqual({
      run: false,
      todo: "needs slice 8b for its expire step",
    });
  });

  it("runs case 10 once its expire step is gone", () => {
    const case10 = cases.get("10")!;
    const withoutExpire = { ...case10, steps: case10.steps.filter((s) => s.step !== "expire") };
    expect(planCase(withoutExpire)).toEqual({ run: true });
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
