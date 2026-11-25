// Guard's per-file agent-config Rules (Guard spec, story 3): `agentConfigCheck(asset).see(file)` reads a Claude Code
// settings file's allow rules and `defaultMode`, and any other text file for the flag that skips permission checks, and
// answers at most one Observation per Rule for the file. The flag and the mode are built here by joining their parts,
// so this file never holds a whole one for a Guard Scan of Warden's own repo to report.
import { readdirSync, readFileSync } from "node:fs";
import { Observation, type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { agentConfigCheck } from "./agent-config.ts";
import { packRule } from "./default-pack.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const BLANKET = "guard/blanket-bash-allow";
const SKIP = "guard/permission-skip";

const join = (...parts: string[]) => parts.join("");
/** The flag that starts Claude Code with its permission checks off. */
const FLAG = join("--dangerously", "-skip-permissions");
const MODE = join("--permission", "-mode");
const BYPASS = join("bypass", "Permissions");

/** A settings file's text, pretty-printed as Claude Code writes it: each allow entry on a line of its own. */
const settings = (permissions: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  `${JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", permissions, ...rest }, null, 2)}\n`;

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

  it.each([
    "Bash(bash -c:*)",
    "Bash(sh -c *)",
    "Bash(zsh -c*)",
    "Bash(python3 -c:*)",
    "Bash(python -c *)",
    "Bash(/bin/cat:*)",
    "Bash(/usr/bin/python3 -c *)",
    "Bash(./bin/grep *)",
    "Bash(~/bin/sed:*)",
  ])(
    "reports %s, a shell or interpreter run with -c or a listed command given by path",
    (entry) => {
      expect(ofRule(".claude/settings.json", settings({ allow: [entry] }), BLANKET)).toHaveLength(
        1,
      );
    },
  );

  it("reports no narrow allow, and nothing in permissions.deny", () => {
    const text = settings({
      allow: ["Bash(npm run test:*)", "Bash(git status)", "Read(./src/**)"],
      deny: ["Bash(*)", "Bash", "Bash(cat:*)"],
    });

    expect(see(".claude/settings.json", text)).toEqual([]);
  });

  it.each([
    "Bash(catalog:*)",
    "Bash(cat file.txt)",
    "Bash(npm *)",
    "bash(*)",
    "Bash(*) ",
    "Bash(/bin/catalog:*)",
    "Bash(/usr/bin/git status)",
    "Bash(npm -c:*)",
    "Bash(bash -c 'npm test')",
  ])("doesn't report %s", (entry) => {
    expect(ofRule(".claude/settings.json", settings({ allow: [entry] }), BLANKET)).toEqual([]);
  });

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
    ["scripts/agent.sh", `#!/bin/sh\nset -e\nclaude ${FLAG} -p "$1"\n`, 3],
    [
      ".github/workflows/ci.yml",
      `jobs:\n  agent:\n    steps:\n      - run: npx claude ${FLAG}\n`,
      4,
    ],
    ["package.json", `{\n  "scripts": {\n    "agent": "claude ${FLAG}"\n  }\n}\n`, 3],
  ])("reports the skip flag in %s on its line", (path, text, line) => {
    const observations = ofRule(path, text, SKIP);

    expect(observations).toEqual([
      {
        asset: repo,
        rule_id: SKIP,
        location: { kind: "file", path, line },
        severity: "high",
        title: "The agent is set to skip its permission checks",
        evidence: {
          summary: `1 place skips the agent's permission checks (${FLAG}) in ${path}, on line ${line}. To fix: ${packRule(SKIP).fix}`,
        },
      },
    ]);
    expect(Observation.safeParse(observations[0]).success).toBe(true);
  });

  it("reports the bypass permission mode in a script", () => {
    const observations = ofRule(
      "scripts/run.sh",
      `#!/bin/sh\n\nexec claude ${MODE} ${BYPASS}\n`,
      SKIP,
    );

    expect(observations.map((o) => [o.location, o.evidence.summary])).toEqual([
      [
        { kind: "file", path: "scripts/run.sh", line: 3 },
        `1 place skips the agent's permission checks (${MODE} ${BYPASS}) in scripts/run.sh, on line 3. To fix: ${packRule(SKIP).fix}`,
      ],
    ]);
  });

  it.each([
    ["with a double-quoted value", "scripts/run.sh", `claude ${MODE} "${BYPASS}" -p go\n`, 1],
    ["with a single-quoted value after =", "scripts/run.sh", `claude ${MODE}='${BYPASS}'\n`, 1],
    [
      "as an argv array",
      "scripts/agent.ts",
      `import { spawn } from "node:child_process";\nspawn("claude", ["-p", "go", "${MODE}","${BYPASS}"]);\n`,
      2,
    ],
    [
      "as an argv array over several lines",
      "scripts/agent.py",
      `subprocess.run([\n    "claude",\n    '${MODE}',\n    '${BYPASS}',\n])\n`,
      3,
    ],
    [
      "across a backslash continuation",
      "scripts/run.sh",
      `#!/bin/sh\nclaude -p go ${MODE} \\\n  ${BYPASS}\n`,
      2,
    ],
  ])("reports the bypass permission mode %s", (_name, path, text, line) => {
    expect(ofRule(path, text, SKIP).map((o) => [o.location, o.evidence.summary])).toEqual([
      [
        { kind: "file", path, line },
        `1 place skips the agent's permission checks (${MODE} ${BYPASS}) in ${path}, on line ${line}. To fix: ${packRule(SKIP).fix}`,
      ],
    ]);
  });

  it.each([
    [
      "src/agent.ts",
      `const options = {\n  model: "opus",\n  permissionMode: "${BYPASS}",\n};\n`,
      3,
    ],
    ["agent/run.py", `options = ClaudeAgentOptions(\n    permission_mode="${BYPASS}",\n)\n`, 2],
    ["agent.json", `{\n  "permissionMode": "${BYPASS}"\n}\n`, 2],
  ])("reports the Agent SDK's permission mode set to bypass in %s", (path, text, line) => {
    expect(ofRule(path, text, SKIP).map((o) => [o.location, o.evidence.summary])).toEqual([
      [
        { kind: "file", path, line },
        `1 place skips the agent's permission checks (permissionMode ${BYPASS}) in ${path}, on line ${line}. To fix: ${packRule(SKIP).fix}`,
      ],
    ]);
  });

  it.each([
    ["another permission mode", "scripts/run.sh", `claude ${MODE} plan\n`],
    [
      "the Agent SDK's default mode",
      "src/agent.ts",
      `const options = { permissionMode: "default" };\n`,
    ],
    ["a longer mode name", "scripts/run.sh", `claude ${MODE} ${BYPASS}Later\n`],
  ])("gives nothing for %s", (_name, path, text) => {
    expect(see(path, text)).toEqual([]);
  });

  it("reports a settings file whose defaultMode is bypassPermissions, on that line, saying which versions apply it", () => {
    const text = settings({ allow: ["Bash(git status)"], defaultMode: BYPASS });

    expect(ofRule(".claude/settings.json", text, SKIP)).toEqual([
      expect.objectContaining({
        location: { kind: "file", path: ".claude/settings.json", line: 7 },
        evidence: {
          summary: `1 place skips the agent's permission checks (defaultMode ${BYPASS} (applies before Claude Code v2.1.257)) in .claude/settings.json, on line 7. To fix: ${packRule(SKIP).fix}`,
        },
      }),
    ]);
  });

  it.each(["acceptEdits", "plan", 7])("doesn't report a defaultMode of %s", (mode) => {
    expect(ofRule(".claude/settings.json", settings({ defaultMode: mode }), SKIP)).toEqual([]);
  });

  it("reads a settings file only for its defaultMode: a deny entry or a hook that blocks the flag isn't a place", () => {
    const text = settings(
      { deny: [`Bash(claude ${FLAG}:*)`, `Bash(claude ${MODE} ${BYPASS}:*)`] },
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `grep -q -- '${FLAG}' && exit 2 || true` }],
            },
          ],
        },
      },
    );

    expect(see(".claude/settings.local.json", text)).toEqual([]);
  });

  it("counts every place in one file, names each kind once, and points at the first", () => {
    const text = [
      "#!/bin/sh",
      `claude ${MODE} ${BYPASS} -p one`,
      `claude ${FLAG} -p two`,
      `claude ${FLAG} -p three`,
    ].join("\n");

    expect(ofRule("scripts/agent.sh", text, SKIP)[0]!.evidence.summary).toBe(
      `3 places skip the agent's permission checks (${MODE} ${BYPASS}, ${FLAG}) in scripts/agent.sh, first on line 2. To fix: ${packRule(SKIP).fix}`,
    );
  });

  it("never quotes the line itself", () => {
    const [observation] = ofRule(
      "scripts/agent.sh",
      `claude ${FLAG} -p "deploy to prod-db-7"\n`,
      SKIP,
    );

    expect(JSON.stringify(observation)).not.toContain("prod-db-7");
  });

  it.each([
    "README.md",
    "docs/agents.txt",
    "docs/guide.mdx",
    "docs/index.rst",
    "CHANGELOG.MD",
    "docs/setup.markdown",
    "docs/agents.adoc",
    "site/index.html",
  ])("gives nothing for the flag in %s", (path) => {
    expect(see(path, `Run \`claude ${FLAG}\` only in a container.\n`)).toEqual([]);
  });

  it.each([
    [
      "a shell comment",
      "scripts/agent.sh",
      `#!/bin/sh\n# Never add ${FLAG} here.\nclaude -p "$1"\n`,
    ],
    [
      "an indented YAML comment",
      ".github/workflows/ci.yml",
      `jobs:\n  agent:\n    # ${MODE} ${BYPASS} would skip the checks\n    steps: []\n`,
    ],
  ])("gives nothing for the flag in %s line", (_name, path, text) => {
    expect(see(path, text)).toEqual([]);
  });

  it("still reports the flag on a #! line, which runs it", () => {
    const observations = ofRule("bin/agent", `#!/usr/bin/env -S claude ${FLAG}\n`, SKIP);

    expect(observations.map((o) => o.location)).toEqual([
      { kind: "file", path: "bin/agent", line: 1 },
    ]);
  });

  it("gives nothing for a file with neither the flag nor the mode", () => {
    expect(see("scripts/agent.sh", '#!/bin/sh\nclaude -p "$1"\n')).toEqual([]);
  });
});

describe("agentConfigCheck", () => {
  it("answers both Rules for one settings file", () => {
    const text = settings({ allow: ["Bash(*)"], defaultMode: BYPASS });

    expect(see(".claude/settings.json", text).map((o) => [o.rule_id, o.location])).toEqual([
      [BLANKET, { kind: "file", path: ".claude/settings.json", line: 5 }],
      [SKIP, { kind: "file", path: ".claude/settings.json", line: 7 }],
    ]);
  });

  it("finds nothing in Guard's own code and tests, so a Guard Scan of Warden's repo opens no Finding for them", () => {
    const server = new URL("../../../", import.meta.url);
    const paths = [
      ...readdirSync(new URL("src/modules/guard/", server), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `src/modules/guard/${entry.name}`),
      "test/guard-scan-api.test.ts",
    ];

    const found = paths.flatMap((path) =>
      see(`server/${path}`, readFileSync(new URL(path, server), "utf8")).map(
        (o) => o.evidence.summary,
      ),
    );

    expect(found).toEqual([]);
  });
});
