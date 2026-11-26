// A test may import Guard and Patch to check the map against the Rules in code; Vouch's own code names them as strings.
import { describe, expect, it } from "vitest";
import { DEFAULT_PACK_RULE_IDS } from "../guard/default-pack.ts";
import { PATCH_RULE } from "../patch/scan.ts";
import { VDA_ISA_2027_1 } from "./catalogue.ts";
import { JUDGE_SPOT_RUN_CONTROLS, RULE_CONTROLS } from "./rule-controls.ts";

const judged = VDA_ISA_2027_1.judgedControls.map((control) => control.id);

/** The Rules the map gives each Control. */
function rulesByControl(): Map<string, string[]> {
  const byControl = new Map<string, string[]>();
  for (const [rule, controls] of Object.entries(RULE_CONTROLS)) {
    for (const control of controls)
      byControl.set(control, [...(byControl.get(control) ?? []), rule]);
  }
  return byControl;
}

describe("RULE_CONTROLS", () => {
  it("names only Rules in code: Guard's Default Pack and Patch's Rule", () => {
    const rulesInCode = [...DEFAULT_PACK_RULE_IDS, PATCH_RULE];

    for (const rule of Object.keys(RULE_CONTROLS)) expect(rulesInCode).toContain(rule);
  });

  it("with the Judge Spot run, names only judged Controls, and covers all four", () => {
    const named = [...Object.values(RULE_CONTROLS).flat(), ...JUDGE_SPOT_RUN_CONTROLS];

    for (const control of named) expect(judged).toContain(control);
    expect(new Set(named)).toEqual(new Set(judged));
  });

  it("gives each judged Control exactly its Rules", () => {
    const byControl = rulesByControl();
    const sorted = (control: string) => [...(byControl.get(control) ?? [])].sort();

    expect(sorted("1.3.3")).toEqual(["guard/mcp-server-unpinned", "guard/unapproved-ai-tool"]);
    expect(sorted("1.3.4")).toEqual([
      "guard/agent-can-read-env",
      "guard/blanket-bash-allow",
      "guard/no-runtime-guard",
      "guard/permission-skip",
      "patch/known-vulnerability",
    ]);
    expect(sorted("4.1.3")).toEqual(["guard/secret-in-agent-settings", "guard/secret-in-repo"]);
    expect(sorted("5.2.4")).toEqual([]);
    expect(JUDGE_SPOT_RUN_CONTROLS).toEqual(["5.2.4"]);
  });
});
