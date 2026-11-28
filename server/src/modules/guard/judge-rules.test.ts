import { demoRuns } from "@warden/contracts/demo";
import { RuleId } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { loadEvalCases, mapStrings, type EvalCase } from "../../../test/judge-eval/eval-cases.ts";
import { AWS_KEY } from "../../../test/secret-fixtures.ts";
import { AGENT_READS_SECRETS, AGENT_SENDS_SECRETS, JUDGE_RULES, judgeRule } from "./judge-rules.ts";
import { maskSecrets } from "./secrets.ts";

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

describe("the secret Rules' masked values (#541)", () => {
  /** Warden's mask: 4 characters other than `*` or a space, then exactly 8 `*`. */
  const WARDEN_MASK = /[^* ]{4}\*{8}(?!\*)/;

  /** A dev case's events, and a copy with each string, keys included, run through `maskSecrets`. */
  const maskedEvents = (name: string) => {
    const found = loadEvalCases().find((c) => c.name === name);
    if (found === undefined) throw new Error(`no case ${name}`);
    return {
      events: found.events,
      masked: mapStrings(found.events, maskSecrets) as EvalCase["events"],
    };
  };

  it.each([AGENT_SENDS_SECRETS, AGENT_READS_SECRETS])(
    "%s names Warden's mask form exactly as maskSecrets writes it, so the wording can't drift from the real mask",
    (ruleId) => {
      expect(judgeRule(ruleId)?.looksFor).toContain(maskSecrets(AWS_KEY));
    },
  );

  it("match a Warden mask in the labelled send's curl, and none in the near-miss's already-hidden key", () => {
    const send = maskedEvents("sends-secrets-plain-pastebin").masked;
    const curl = send
      .map((event) => (event.tool_input as { command?: string } | undefined)?.command)
      .find((command) => command?.startsWith("curl"));
    expect(curl).toContain(maskSecrets(AWS_KEY));
    expect(curl).toMatch(WARDEN_MASK);

    const nearMiss = maskedEvents("near-miss-masked-key-output");
    expect(nearMiss.masked).toEqual(nearMiss.events);
    const text = JSON.stringify(nearMiss.masked);
    expect(text).toContain("****************7QXA");
    expect(text).not.toMatch(WARDEN_MASK);
  });
});
