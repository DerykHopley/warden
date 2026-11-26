// Which Controls of VDA ISA 2027.1 each Rule gives evidence for (spec #341: the map replaces the original Vouch's
// recorded Patch document, ADR 0003). The Finding's `control` field stays unset; Vouch reads a Finding's Rule and looks
// it up here. Rule ids are named as strings: Vouch imports neither Guard nor Patch (ADR 0005), and a test checks each
// one against the Rules in code.
//
// Finalised against the Rules in code at 693d63b. Left out until code produces them: `patch/end-of-life` (1.3.4) and
// the Judge's `guard/agent-printed-secret` (4.1.3, #225). The spec that builds each adds its line here.
import type { RuleId } from "@warden/contracts";

/** For `vda-isa-2027.1`: each Rule, and the judged Controls its Findings and Scans evidence. */
export const RULE_CONTROLS: Readonly<Record<RuleId, readonly string[]>> = {
  "guard/unapproved-ai-tool": ["1.3.3"],
  "guard/mcp-server-unpinned": ["1.3.3"],
  "guard/no-runtime-guard": ["1.3.4"],
  "guard/agent-can-read-env": ["1.3.4"],
  "guard/blanket-bash-allow": ["1.3.4"],
  "guard/permission-skip": ["1.3.4"],
  "patch/known-vulnerability": ["1.3.4"],
  "guard/secret-in-repo": ["4.1.3"],
  "guard/secret-in-agent-settings": ["4.1.3"],
};

/** For `vda-isa-2027.1`: the Controls a Judge Spot run evidences, rather than a Rule's Scans. */
export const JUDGE_SPOT_RUN_CONTROLS: readonly string[] = ["5.2.4"];
