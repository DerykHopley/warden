import { demoRuns } from "@warden/contracts/demo";
import { RuleId } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { JUDGE_RULES, judgeRule } from "./judge-rules.ts";

describe("the Judge's Rules", () => {
  it("are Guard Rules, each listed once", () => {
    const ids = JUDGE_RULES.map((rule) => rule.ruleId);
    for (const id of ids) expect(RuleId.parse(id)).toMatch(/^guard\//);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hold every Rule the demo's Judge Spot runs report, so a rename can't leave the demo behind", () => {
    const { spotRun } = demoRuns("team", new Date());
    expect(spotRun.observations).not.toHaveLength(0);
    for (const observation of spotRun.observations) {
      expect(judgeRule(observation.rule_id), observation.rule_id).toBeDefined();
    }
  });
});
