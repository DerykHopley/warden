// The runner itself: every case runs (none is todo), and each case gets a Team of its own.
import { loadReconcileCases } from "@warden/contracts/reconcile-cases";
import { describe, expect, it } from "vitest";
import { withTeamId } from "./reconcile-case-runner.ts";

const cases = new Map(loadReconcileCases().map(({ file, case: c }) => [file.slice(0, 2), c]));

describe("the cases the runner runs", () => {
  it("no case is todo: the cases use only the four step kinds runCase runs, case 10's expire among them", () => {
    const kinds = new Set([...cases.values()].flatMap((c) => c.steps.map((step) => step.step)));

    expect([...kinds].sort()).toEqual(["decision", "expire", "scan", "spot_run"]);
    expect(cases.get("10")!.steps.map((step) => step.step)).toContain("expire");
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
