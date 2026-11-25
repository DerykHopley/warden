// The Default Pack as data (Guard spec, story 3): the Rules a Guard Scan checks, each with its Severity, title and fix,
// and the Rules Guard's scanner says it covers.
import { describe, expect, it } from "vitest";
import { createLogger } from "../../log.ts";
import { DEFAULT_PACK, packRule } from "./default-pack.ts";
import { guardScanner } from "./scanner.ts";

describe("the Default Pack", () => {
  it("holds the two secret Rules and the two per-file agent-config Rules", () => {
    expect(DEFAULT_PACK.map((rule) => rule.ruleId)).toEqual([
      "guard/secret-in-repo",
      "guard/secret-in-agent-settings",
      "guard/blanket-bash-allow",
      "guard/permission-skip",
    ]);
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
});
