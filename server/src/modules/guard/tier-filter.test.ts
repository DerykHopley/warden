// What an Agent event keeps at the Team's Privacy tier (#183): in this slice, only the Metadata fields at every tier.
import type { PrivacyTier } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { filterToTier } from "./tier-filter.ts";

const TIERS: PrivacyTier[] = ["metadata", "details", "content"];

/** Every Metadata field, each with a value that's kept. */
const metadata = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: "toolu_01ABC",
  permission_mode: "default",
  agent_id: "agent-1",
  agent_type: "Explore",
  source: "startup",
  reason: "other",
  model: "claude-opus",
};

/** Claude Code's other fields, and one it might add later. */
const others = {
  session_id: "abc123",
  prompt_id: "550e8400",
  cwd: "/home/alice/app",
  transcript_path: "/home/alice/.claude/projects/x.jsonl",
  tool_input: { command: "cat .env" },
  tool_response: { stdout: "SECRET=1" },
  error: "command failed",
  prompt: "deploy it",
  effort: { level: "high" },
  some_new_field: "added later",
};

describe("filterToTier", () => {
  it.each(TIERS)("keeps exactly the Metadata fields at %s, dropping every other", (tier) => {
    expect(filterToTier({ ...metadata, ...others }, tier)).toEqual(metadata);
  });

  it.each([
    ["an object", { name: "Bash" }],
    ["a number", 7],
    ["a boolean", true],
    ["null", null],
    ["an array", ["Bash"]],
    ["a string over 256 characters", "x".repeat(257)],
    // Postgres stores neither in jsonb, so either would refuse the whole event.
    ["a string holding a NUL", "Ba\u0000sh"],
    ["a string with a lone surrogate", "Bash\ud800"],
  ])("drops a kept field whose value is %s", (_name, value) => {
    expect(filterToTier({ hook_event_name: "PostToolUse", tool_name: value }, "content")).toEqual({
      hook_event_name: "PostToolUse",
    });
  });

  it("keeps a string of exactly 256 characters", () => {
    const model = "m".repeat(256);
    expect(filterToTier({ model }, "metadata")).toEqual({ model });
  });

  it("keeps no field from the object's prototype", () => {
    const event = JSON.parse('{"__proto__": {"tool_name": "Bash"}}') as Record<string, unknown>;
    expect(filterToTier(event, "content")).toEqual({});
  });
});
