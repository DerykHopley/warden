// The Default Pack as data (Guard spec, story 3): the Rules a Guard Scan checks, each with its Severity, title and fix,
// and the Rules Guard's scanner says it covers.
import { DEMO_OBSERVATIONS } from "@warden/contracts/demo";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../log.ts";
import { DEFAULT_PACK, DEFAULT_PACK_RULE_IDS, packRule, SECRET_IN_REPO } from "./default-pack.ts";
import { guardScanner } from "./scanner.ts";

describe("the Default Pack", () => {
  it("holds the two secret Rules, the two per-file agent-config Rules and the two whole-repo ones", () => {
    expect(DEFAULT_PACK.map((rule) => rule.ruleId)).toEqual([
      "guard/secret-in-repo",
      "guard/secret-in-agent-settings",
      "guard/blanket-bash-allow",
      "guard/permission-skip",
      "guard/agent-can-read-env",
      "guard/no-runtime-guard",
    ]);
  });

  it("gives the whole-repo agent-config Rules their Severity, title and fix", () => {
    expect(packRule("guard/agent-can-read-env")).toEqual({
      ruleId: "guard/agent-can-read-env",
      severity: "high",
      title: "The agent can read .env files",
      fix: "Add Read(./.env) and Read(./.env.*) to permissions.deny in .claude/settings.json.",
    });
    expect(packRule("guard/no-runtime-guard")).toEqual({
      ruleId: "guard/no-runtime-guard",
      severity: "medium",
      title: "Nothing checks the agent's tool calls",
      fix: "Add permissions.deny rules for secret files and a PreToolUse guard hook to .claude/settings.json.",
    });
  });

  it("gives the agent-config Rules their Severity, title and fix", () => {
    expect(packRule("guard/blanket-bash-allow")).toEqual({
      ruleId: "guard/blanket-bash-allow",
      severity: "high",
      title: "A broad Bash allow gets round the agent's deny rules",
      fix: "Replace each broad Bash allow with the exact commands the agent needs.",
    });
    expect(packRule("guard/permission-skip")).toEqual({
      ruleId: "guard/permission-skip",
      severity: "high",
      title: "The agent is set to skip its permission checks",
      fix: "Remove the flag or setting, so the agent asks before each risky tool call.",
    });
  });

  it("is what Guard's scanner covers", () => {
    const scanner = guardScanner({
      repoAssets: { list: async () => [], outside: async () => [] },
      logger: createLogger(() => {}),
    });

    expect(scanner.rules).toEqual(DEFAULT_PACK.map((rule) => rule.ruleId));
  });

  it("holds the Rule the demo's committed-secret Finding names, so a rename can't leave the demo behind", () => {
    expect(DEMO_OBSERVATIONS.secret.rule_id).toBe(SECRET_IN_REPO);
    expect(DEFAULT_PACK_RULE_IDS).toContain(DEMO_OBSERVATIONS.secret.rule_id);
  });
});
