// The Default Pack as data (Guard spec, story 3): the Rules a Guard Scan checks, each with its Severity, title and fix,
// and the Rules Guard's scanner says it covers.
import { DEMO_OBSERVATIONS, demoRuns } from "@warden/contracts/demo";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../log.ts";
import {
  BLANKET_BASH_ALLOW,
  DEFAULT_PACK,
  DEFAULT_PACK_RULE_IDS,
  packRule,
  SECRET_IN_REPO,
} from "./default-pack.ts";
import { guardScanner } from "./scanner.ts";

describe("the Default Pack", () => {
  it("holds the two secret Rules, the two per-file agent-config Rules, the two whole-repo ones, the MCP server Rule and the other-AI-tool Rule, in the spec's order", () => {
    expect(DEFAULT_PACK.map((rule) => rule.ruleId)).toEqual([
      "guard/secret-in-repo",
      "guard/secret-in-agent-settings",
      "guard/blanket-bash-allow",
      "guard/permission-skip",
      "guard/agent-can-read-env",
      "guard/no-runtime-guard",
      "guard/mcp-server-unpinned",
      "guard/unapproved-ai-tool",
    ]);
  });

  it("gives the other-AI-tool Rule its Severity, title and fix", () => {
    expect(packRule("guard/unapproved-ai-tool")).toEqual({
      ruleId: "guard/unapproved-ai-tool",
      severity: "medium",
      title: "Another AI tool's config is in the repo",
      fix: "Remove the tool's config, or accept the Finding if your Team approves the tool.",
    });
  });

  it("gives the MCP server Rule its Severity, title and fix", () => {
    expect(packRule("guard/mcp-server-unpinned")).toEqual({
      ruleId: "guard/mcp-server-unpinned",
      severity: "medium",
      title: "An MCP server runs without a pinned version",
      fix: "Pin each MCP server to an exact version: a package's x.y.z, or an image's digest or version tag.",
    });
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

  it("holds the Rule the demo's broad-Bash-allow Finding names, whose title is that Rule's", () => {
    expect(DEMO_OBSERVATIONS.push.rule_id).toBe(BLANKET_BASH_ALLOW);
    expect(DEMO_OBSERVATIONS.push.title).toBe(packRule(BLANKET_BASH_ALLOW).title);
  });

  it("holds every Rule the demo's Guard Scans cover or report on the Repo, so the demo shows only Rules a Scan reports", () => {
    const guardScans = demoRuns("team", new Date()).scans.filter((scan) => scan.module === "guard");
    expect(guardScans).not.toHaveLength(0);
    for (const scan of guardScans) {
      const onRepo = scan.observations.filter((o) => o.asset.kind === "repo");
      // The device Rule is checked on a Device, which no Guard Scan of a repo reads.
      const covered = scan.rules.filter((rule) => rule !== DEMO_OBSERVATIONS.disk.rule_id);
      expect(DEFAULT_PACK_RULE_IDS).toEqual(expect.arrayContaining(covered));
      expect(covered).toEqual(expect.arrayContaining(onRepo.map((o) => o.rule_id)));
    }
  });
});
