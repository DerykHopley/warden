// What an Agent event keeps at the Team's Privacy tier (#183, #184): the Metadata fields at every tier, commands,
// paths and URLs from Details, and the tool's whole input and output, errors and prompts at Content.
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

/** Claude Code's fields above Metadata, and ones Warden never keeps. */
const others = {
  session_id: "abc123",
  prompt_id: "550e8400",
  cwd: "/home/alice/app",
  transcript_path: "/home/alice/.claude/projects/x.jsonl",
  tool_input: { command: "cat .env", description: "Read it", timeout: 5 },
  tool_response: { stdout: "SECRET=1" },
  error: "command failed",
  prompt: "deploy it",
  effort: { level: "high" },
  some_new_field: "added later",
};

/** A Write's input: its path at Details, its content only at Content. */
const writeInput = { file_path: "/home/alice/app/a.ts", content: "export {};" };

/** An Edit's input. */
const editInput = { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: false };

/** An MCP tool's input: none of its keys is a listed one. */
const mcpInput = { query: "select 1", database: "prod" };

/** Each tier's `tool_input`, `undefined` where the tier keeps none. */
const TOOL_INPUTS: [string, unknown, Record<PrivacyTier, unknown>][] = [
  [
    "a Bash command",
    others.tool_input,
    {
      metadata: undefined,
      details: { command: "cat .env", description: "Read it" },
      content: others.tool_input,
    },
  ],
  [
    "a Write",
    writeInput,
    { metadata: undefined, details: { file_path: writeInput.file_path }, content: writeInput },
  ],
  [
    "an Edit",
    editInput,
    { metadata: undefined, details: { file_path: "a.ts" }, content: editInput },
  ],
  ["an MCP tool's", mcpInput, { metadata: undefined, details: undefined, content: mcpInput }],
  [
    "every listed key",
    {
      command: "c",
      description: "d",
      file_path: "f",
      path: "p",
      notebook_path: "n",
      url: "u",
      pattern: "*.ts",
      glob: "**",
      new_source: "s",
      prompt: "fetch it",
    },
    {
      metadata: undefined,
      details: {
        command: "c",
        description: "d",
        file_path: "f",
        path: "p",
        notebook_path: "n",
        url: "u",
        pattern: "*.ts",
        glob: "**",
      },
      content: expect.objectContaining({ new_source: "s", prompt: "fetch it" }),
    },
  ],
  [
    "a listed key whose value isn't a string",
    { command: ["rm", "-rf"], path: 7 },
    { metadata: undefined, details: undefined, content: { command: ["rm", "-rf"], path: 7 } },
  ],
  ["a string", "ls", { metadata: undefined, details: undefined, content: "ls" }],
  ["an array", ["ls"], { metadata: undefined, details: undefined, content: ["ls"] }],
  ["null", null, { metadata: undefined, details: undefined, content: null }],
];

describe("filterToTier: each tier's fields", () => {
  it("keeps exactly the Metadata fields at metadata, dropping every other", () => {
    expect(filterToTier({ ...metadata, ...others }, "metadata")).toEqual(metadata);
  });

  it("adds cwd, transcript_path and tool_input's commands, paths and URLs at details", () => {
    expect(filterToTier({ ...metadata, ...others }, "details")).toEqual({
      ...metadata,
      cwd: others.cwd,
      transcript_path: others.transcript_path,
      tool_input: { command: "cat .env", description: "Read it" },
    });
  });

  it("adds the whole tool_input and tool_response, error and prompt at content", () => {
    expect(filterToTier({ ...metadata, ...others }, "content")).toEqual({
      ...metadata,
      cwd: others.cwd,
      transcript_path: others.transcript_path,
      tool_input: others.tool_input,
      tool_response: others.tool_response,
      error: others.error,
      prompt: others.prompt,
    });
  });

  describe.each(TOOL_INPUTS)("tool_input: %s", (_name, toolInput, kept) => {
    it.each(TIERS)("at %s", (tier) => {
      const fields = filterToTier({ tool_input: toolInput }, tier);
      if (kept[tier] === undefined) expect(fields).not.toHaveProperty("tool_input");
      else expect(fields.tool_input).toEqual(kept[tier]);
    });
  });

  it.each([
    ["an object", { stdout: "ok", stderr: "" }],
    ["an array", [{ type: "text", text: "ok" }]],
    ["a string", "ok"],
    ["a number", 0],
    ["a boolean", false],
    ["null", null],
  ])("keeps a tool_response that's %s at content only", (_name, toolResponse) => {
    expect(filterToTier({ tool_response: toolResponse }, "metadata")).toEqual({});
    expect(filterToTier({ tool_response: toolResponse }, "details")).toEqual({});
    expect(filterToTier({ tool_response: toolResponse }, "content")).toEqual({
      tool_response: toolResponse,
    });
  });

  it.each([
    ["cwd", { path: "/home/alice" }],
    ["transcript_path", 7],
    ["error", { message: "failed" }],
    ["prompt", ["deploy it"]],
  ])("drops a %s that isn't a string at every tier", (field, value) => {
    for (const tier of TIERS) expect(filterToTier({ [field]: value }, tier)).toEqual({});
  });

  it("keeps a long command whole, past the Metadata fields' 256 characters", () => {
    const command = `echo ${"x".repeat(100_000)} && rm -rf /`;
    expect(filterToTier({ tool_input: { command } }, "details")).toEqual({
      tool_input: { command },
    });
  });
});

describe.each(TIERS)("filterToTier: the Metadata fields' rule at %s", (tier) => {
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
    expect(filterToTier({ hook_event_name: "PostToolUse", tool_name: value }, tier)).toEqual({
      hook_event_name: "PostToolUse",
    });
  });

  it("drops a 257-character model", () => {
    expect(filterToTier({ model: "m".repeat(257) }, tier)).toEqual({});
  });

  it("keeps a string of exactly 256 characters", () => {
    const model = "m".repeat(256);
    expect(filterToTier({ model }, tier)).toEqual({ model });
  });

  it("keeps no field from the object's prototype", () => {
    const event = JSON.parse(
      '{"__proto__": {"tool_name": "Bash", "cwd": "/home/alice", "tool_response": "x"}}',
    ) as Record<string, unknown>;
    expect(filterToTier(event, tier)).toEqual({});
  });
});

/** A value `levels` objects and arrays deep, by turns, with a string at the bottom. */
function nested(levels: number): unknown {
  let value: unknown = "bottom";
  for (let i = 0; i < levels; i++) value = i % 2 === 0 ? { inner: value } : [value];
  return value;
}

describe("filterToTier: the depth bound at content", () => {
  it("keeps a tool_response nested 64 levels deep and drops one nested 65 whole", () => {
    expect(filterToTier({ tool_response: nested(64) }, "content")).toEqual({
      tool_response: nested(64),
    });
    expect(filterToTier({ tool_response: nested(65), error: "e" }, "content")).toEqual({
      error: "e",
    });
  });

  it("drops a tool_input nested 65 levels deep whole at content", () => {
    expect(filterToTier({ tool_input: { command: "ls", deep: nested(64) } }, "content")).toEqual(
      {},
    );
  });
});

describe("filterToTier: storable strings at details and content", () => {
  it("replaces each NUL and lone surrogate with U+FFFD, in strings and keys at any depth", () => {
    const event = {
      cwd: "/home/a\u0000b",
      tool_input: { command: "ls\ud800", content: "c\udc00d" },
      tool_response: { ["k\u0000\ud800"]: [{ text: "a\u0000b\ud800c" }], ok: "fine" },
      prompt: "p\u0000",
    };

    expect(filterToTier(event, "details")).toEqual({
      cwd: "/home/a�b",
      tool_input: { command: "ls�" },
    });
    expect(filterToTier(event, "content")).toEqual({
      cwd: "/home/a�b",
      tool_input: { command: "ls�", content: "c�d" },
      tool_response: { ["k��"]: [{ text: "a�b�c" }], ok: "fine" },
      prompt: "p�",
    });
  });

  it.each(["details", "content"] as const)(
    "keeps a well-formed surrogate pair as it is at %s",
    (tier) => {
      expect(filterToTier({ cwd: "/srv/\u{1F680}" }, tier)).toEqual({ cwd: "/srv/\u{1F680}" });
    },
  );
});
