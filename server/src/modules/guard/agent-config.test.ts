// Guard's per-file agent-config Rules (Guard spec, story 3): `agentConfigCheck(asset).see(file)` reads a Claude Code
// settings file's allow rules and `defaultMode`, and any text file for the flag that skips permission checks, and
// answers at most one Observation per Rule for the file.
import { Observation, type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { agentConfigCheck } from "./agent-config.ts";
import { packRule } from "./default-pack.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const BLANKET = "guard/blanket-bash-allow";
const SKIP = "guard/permission-skip";

/** A settings file's text, pretty-printed as Claude Code writes it: each allow entry on a line of its own. */
const settings = (permissions: Record<string, unknown>) =>
  `${JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", permissions }, null, 2)}\n`;

const see = (path: string, text: string) => agentConfigCheck(repo).see({ path, text });
const ofRule = (path: string, text: string, rule: string) =>
  see(path, text).filter((observation) => observation.rule_id === rule);

describe("guard/blanket-bash-allow", () => {
  it.each(["Bash", "Bash(*)", "Bash(:*)", "Bash(cat:*)", "Bash(grep *)"])(
    "reports %s in permissions.allow, on the entry's line",
    (entry) => {
      // Line 1 `{`, 2 `$schema`, 3 `"permissions": {`, 4 `"allow": [`, 5 the narrow entry, 6 the broad one.
      const text = settings({ allow: ["Bash(git status)", entry] });

      const observations = ofRule(".claude/settings.json", text, BLANKET);

      expect(observations).toEqual([
        {
          asset: repo,
          rule_id: BLANKET,
          location: { kind: "file", path: ".claude/settings.json", line: 6 },
          severity: "high",
          title: "A broad Bash allow gets round the agent's deny rules",
          evidence: {
            summary: `1 broad Bash allow (${entry}) in .claude/settings.json, on line 6. To fix: ${packRule(BLANKET).fix}`,
          },
        },
      ]);
      expect(Observation.safeParse(observations[0]).success).toBe(true);
    },
  );

  it.each([
    "Bash(**)",
    "Bash(rg:*)",
    "Bash(python3 *)",
    "Bash(sh*)",
    "Bash(xargs:*)",
    "Bash(printenv *)",
  ])("reports %s as broad", (entry) => {
    expect(ofRule(".claude/settings.json", settings({ allow: [entry] }), BLANKET)).toHaveLength(1);
  });

  it("reports no narrow allow, and nothing in permissions.deny", () => {
    const text = settings({
      allow: ["Bash(npm run test:*)", "Bash(git status)", "Read(./src/**)"],
      deny: ["Bash(*)", "Bash", "Bash(cat:*)"],
    });

    expect(see(".claude/settings.json", text)).toEqual([]);
  });

  it.each(["Bash(catalog:*)", "Bash(cat file.txt)", "Bash(npm *)", "bash(*)", "Bash(*) "])(
    "doesn't report %s",
    (entry) => {
      expect(ofRule(".claude/settings.json", settings({ allow: [entry] }), BLANKET)).toEqual([]);
    },
  );

  it("gives one Observation for four broad allows: a count, the first three, and how many more", () => {
    const text = settings({
      allow: [
        "Bash(npm run build)",
        "Bash(cat:*)",
        "Bash",
        "Bash(git log *)",
        "Bash(sed *)",
        "Bash(*)",
      ],
    });

    const observations = ofRule(".claude/settings.json", text, BLANKET);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.location).toEqual({
      kind: "file",
      path: ".claude/settings.json",
      line: 6,
    });
    expect(observations[0]!.evidence.summary).toBe(
      `4 broad Bash allows (Bash(cat:*), Bash, Bash(sed *) and 1 more) in .claude/settings.json, first on line 6. To fix: ${packRule(BLANKET).fix}`,
    );
  });

  it("names every broad allow when there are three or fewer", () => {
    const text = settings({ allow: ["Bash(*)", "Bash(cat:*)"] });

    expect(ofRule(".claude/settings.json", text, BLANKET)[0]!.evidence.summary).toBe(
      `2 broad Bash allows (Bash(*), Bash(cat:*)) in .claude/settings.json, first on line 5. To fix: ${packRule(BLANKET).fix}`,
    );
  });

  it("reports a broad allow in a nested folder's settings.local.json at that path", () => {
    const observations = ofRule(
      "apps/web/.claude/settings.local.json",
      settings({ allow: ["Bash(*)"] }),
      BLANKET,
    );

    expect(observations.map((observation) => observation.location)).toEqual([
      { kind: "file", path: "apps/web/.claude/settings.local.json", line: 5 },
    ]);
  });

  it("finds the allow entry's line, not an earlier deny entry with the same text", () => {
    const text = [
      "{",
      '  "permissions": {',
      '    "deny": ["Bash(*)"],',
      '    "allow": [',
      '      "Read(./src/**)",',
      '      "Bash(*)"',
      "    ]",
      "  }",
      "}",
    ].join("\n");

    expect(ofRule(".claude/settings.json", text, BLANKET)[0]!.location).toEqual({
      kind: "file",
      path: ".claude/settings.json",
      line: 6,
    });
  });

  it("steps over other keys' values, brackets in strings and deep nesting, to the allow entry's line", () => {
    const deep = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    const text = [
      "{",
      `  "env": { "NOTE": "a ] } [ { \\" quoted" },`,
      `  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [[["x"]]] }] },`,
      `  "deep": ${deep},`,
      '  "permissions": {',
      '    "allow": ["Bash(git status)",',
      '      "Bash(cat:*)"]',
      "  }",
      "}",
    ].join("\n");

    expect(ofRule(".claude/settings.json", text, BLANKET)[0]!.location).toEqual({
      kind: "file",
      path: ".claude/settings.json",
      line: 7,
    });
  });

  it.each([
    ["isn't valid JSON", '{\n  "permissions": { "allow": ["Bash(*)", ] }\n}\n'],
    ["holds allow as a string", settings({ allow: "Bash(*)" })],
    ["holds allow as an object", settings({ allow: { 0: "Bash(*)" } })],
    ["holds permissions as an array", '{ "permissions": [{ "allow": ["Bash(*)"] }] }'],
    ["is a JSON array", '[{ "permissions": { "allow": ["Bash(*)"] } }]'],
    ["is empty", ""],
  ])("gives nothing for a settings file that %s, and throws nothing", (_name, text) => {
    expect(() => see(".claude/settings.json", text)).not.toThrow();
    expect(ofRule(".claude/settings.json", text, BLANKET)).toEqual([]);
  });

  it("skips an allow entry that isn't a string", () => {
    const text = settings({ allow: [42, null, { rule: "Bash(*)" }, "Bash(cat:*)"] });

    expect(ofRule(".claude/settings.json", text, BLANKET)[0]!.evidence.summary).toContain(
      "1 broad Bash allow (Bash(cat:*))",
    );
  });

  it.each([".mcp.json", "settings.json", "claude/settings.json", ".claude/settings.json.bak"])(
    "doesn't read %s as settings",
    (path) => {
      expect(ofRule(path, settings({ allow: ["Bash(*)"] }), BLANKET)).toEqual([]);
    },
  );
});

describe("guard/permission-skip", () => {
  it.each([
    ["scripts/agent.sh", '#!/bin/sh\nset -e\nclaude --dangerously-skip-permissions -p "$1"\n', 3],
    [
      ".github/workflows/ci.yml",
      "jobs:\n  agent:\n    steps:\n      - run: npx claude --dangerously-skip-permissions\n",
      4,
    ],
    [
      "package.json",
      '{\n  "scripts": {\n    "agent": "claude --dangerously-skip-permissions"\n  }\n}\n',
      3,
    ],
  ])("reports --dangerously-skip-permissions in %s on its line", (path, text, line) => {
    const observations = ofRule(path, text, SKIP);

    expect(observations).toEqual([
      {
        asset: repo,
        rule_id: SKIP,
        location: { kind: "file", path, line },
        severity: "high",
        title: "The agent is set to skip its permission checks",
        evidence: {
          summary: `1 place skips the agent's permission checks (--dangerously-skip-permissions) in ${path}, on line ${line}. To fix: ${packRule(SKIP).fix}`,
        },
      },
    ]);
    expect(Observation.safeParse(observations[0]).success).toBe(true);
  });

  it("reports --permission-mode bypassPermissions in a script", () => {
    const observations = ofRule(
      "scripts/run.sh",
      "#!/bin/sh\n\nexec claude --permission-mode bypassPermissions\n",
      SKIP,
    );

    expect(observations.map((o) => [o.location, o.evidence.summary])).toEqual([
      [
        { kind: "file", path: "scripts/run.sh", line: 3 },
        `1 place skips the agent's permission checks (--permission-mode bypassPermissions) in scripts/run.sh, on line 3. To fix: ${packRule(SKIP).fix}`,
      ],
    ]);
  });

  it("reports a settings file whose defaultMode is bypassPermissions, on that line", () => {
    const text = settings({ allow: ["Bash(git status)"], defaultMode: "bypassPermissions" });

    expect(ofRule(".claude/settings.json", text, SKIP)).toEqual([
      expect.objectContaining({
        location: { kind: "file", path: ".claude/settings.json", line: 7 },
        evidence: {
          summary: `1 place skips the agent's permission checks (defaultMode bypassPermissions) in .claude/settings.json, on line 7. To fix: ${packRule(SKIP).fix}`,
        },
      }),
    ]);
  });

  it.each(["acceptEdits", "plan", 7])("doesn't report a defaultMode of %s", (mode) => {
    expect(ofRule(".claude/settings.json", settings({ defaultMode: mode }), SKIP)).toEqual([]);
  });

  it("counts every place in one file, names each kind once, and points at the first", () => {
    const text = [
      "#!/bin/sh",
      "claude --permission-mode bypassPermissions -p one",
      "claude --dangerously-skip-permissions -p two",
      "claude --dangerously-skip-permissions -p three",
    ].join("\n");

    expect(ofRule("scripts/agent.sh", text, SKIP)[0]!.evidence.summary).toBe(
      `3 places skip the agent's permission checks (--permission-mode bypassPermissions, --dangerously-skip-permissions) in scripts/agent.sh, first on line 2. To fix: ${packRule(SKIP).fix}`,
    );
  });

  it("never quotes the line itself", () => {
    const [observation] = ofRule(
      "scripts/agent.sh",
      'claude --dangerously-skip-permissions -p "deploy to prod-db-7"\n',
      SKIP,
    );

    expect(JSON.stringify(observation)).not.toContain("prod-db-7");
  });

  it.each(["README.md", "docs/agents.txt", "docs/guide.mdx", "docs/index.rst", "CHANGELOG.MD"])(
    "gives nothing for the flag in %s",
    (path) => {
      expect(
        see(path, "Run `claude --dangerously-skip-permissions` only in a container.\n"),
      ).toEqual([]);
    },
  );

  it("gives nothing for a file with neither the flag nor the mode", () => {
    expect(see("scripts/agent.sh", '#!/bin/sh\nclaude -p "$1"\n')).toEqual([]);
  });
});

describe("agentConfigCheck", () => {
  it("answers both Rules for one settings file", () => {
    const text = settings({ allow: ["Bash(*)"], defaultMode: "bypassPermissions" });

    expect(see(".claude/settings.json", text).map((o) => [o.rule_id, o.location])).toEqual([
      [BLANKET, { kind: "file", path: ".claude/settings.json", line: 5 }],
      [SKIP, { kind: "file", path: ".claude/settings.json", line: 7 }],
    ]);
  });
});
