// Guard's agent-config Rules (Guard spec, story 3): `agentConfigCheck(asset).see(file)` reads a Claude Code settings
// file's allow rules, `defaultMode` and the commands it runs (hooks, `statusLine`, `apiKeyHelper`), and any other text
// file for the flag that skips permission checks, and answers at most one Observation per Rule for the file; `end()`
// answers the whole-repo Rules from the root settings files. The flag and the mode are built here by joining their
// parts, so this file never holds a whole one for a Guard Scan of Warden's own repo to report.
import { readdirSync, readFileSync } from "node:fs";
import { Observation, type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { lineWith } from "../../../test/text-lines.ts";
import { agentConfigCheck } from "./agent-config.ts";
import { packRule } from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";
import { ARCHIVE_LIMITS } from "./tarball.ts";

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

const READ_ENV = "guard/agent-can-read-env";
const NO_GUARD = "guard/no-runtime-guard";

/** A settings file's `hooks` key: one matcher group under `event`, holding one command hook. */
const hooks = (event: string, command: string) => ({
  hooks: { [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
});

/** A repo's whole-repo Observations: each file seen, each path reported unread, then the end pass. */
function endOf(files: RepoFile[], unread: string[] = []) {
  const check = agentConfigCheck(repo);
  for (const file of files) check.see(file);
  for (const path of unread) check.unread(path);
  return check.end();
}

const ruleIds = (observations: Observation[] | undefined) =>
  observations?.map((observation) => observation.rule_id);

const CLAUDE_MD: RepoFile = {
  path: "CLAUDE.md",
  text: "# App\n\nRun the tests before each commit.\n",
};

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
    "Bash(node -e:*)",
    "Bash(perl -e *)",
    "Bash(ruby -e*)",
    "Bash(/usr/bin/node -e:*)",
  ])(
    "reports %s, a shell or interpreter run with -c or -e, or a listed command given by path",
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
    "Bash(npm -e:*)",
    "Bash(node -e 'console.log(1)')",
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

  it("cuts a long broad allow its summary names to 64 characters", () => {
    const entry = `Bash(${"/opt/tools".repeat(8)}/cat:*)`;
    const text = settings({ allow: [entry] });

    expect(ofRule(".claude/settings.json", text, BLANKET)[0]!.evidence.summary).toBe(
      `1 broad Bash allow (${entry.slice(0, 63)}…) in .claude/settings.json, on line 5. To fix: ${packRule(BLANKET).fix}`,
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
  /** A command's place past its shells' limit: it may skip the checks, but isn't read. */
  const TOO_DEEP = "more than 4 shells in one command, nested too deep to check";

  /** The one Finding of a file with one place that skips the checks, of `kind`, on `line`. */
  const onePlace = (path: string, line: number, kind: string) => [
    expect.objectContaining({
      location: { kind: "file", path, line },
      evidence: {
        summary: `1 place ${kind === TOO_DEEP ? "may skip" : "skips"} the agent's permission checks (${kind}) in ${path}, on line ${line}. To fix: ${packRule(SKIP).fix}`,
      },
    }),
  ];

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

  it("reports a Stop hook in a minified settings file whose command runs claude with the skip flag", () => {
    const text = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"claude ${FLAG} -p x"}]}]}}`;

    expect(ofRule(".claude/settings.json", text, SKIP).map((o) => o.location)).toEqual([
      { kind: "file", path: ".claude/settings.json", line: 1 },
    ]);
  });

  it.each([
    [".claude/settings.json", "Stop", `claude ${FLAG} -p x`, FLAG],
    [".claude/settings.json", "Stop", `claude ${FLAG} -p "review"`, FLAG],
    [
      ".claude/settings.json",
      "PreToolUse",
      `npx @anthropic-ai/claude-code ${MODE} ${BYPASS}`,
      `${MODE} ${BYPASS}`,
    ],
    [
      "apps/web/.claude/settings.local.json",
      "PreToolUse",
      `npx @anthropic-ai/claude-code ${MODE} ${BYPASS}`,
      `${MODE} ${BYPASS}`,
    ],
    [".claude/settings.json", "PreToolUse", `claude -p x && claude ${FLAG} -p y`, FLAG],
    [".claude/settings.json", "PreToolUse", `claude "${FLAG}" -p x`, FLAG],
    [".claude/settings.json", "PreToolUse", `claude ${MODE} "${BYPASS}"`, `${MODE} ${BYPASS}`],
    // A shell's `-c` string is read as a command.
    [
      ".claude/settings.json",
      "PreToolUse",
      `bash -c 'claude ${MODE} ${BYPASS} -p hi'`,
      `${MODE} ${BYPASS}`,
    ],
    // A redirect's `&` or `|`, or a separator inside a group or backquotes the run opened, doesn't end its arguments.
    ...[
      `claude -p x 2>&1 ${FLAG}`,
      `claude -p x >&2 ${FLAG}`,
      `claude -p x &>out ${FLAG}`,
      `claude -p x &>>out ${FLAG}`,
      `claude -p x <&0 ${FLAG}`,
      `claude -p x >|out ${FLAG}`,
      `claude -p $(echo hi) ${FLAG}`,
      `claude -p <(echo hi) ${FLAG}`,
      `claude -p $((1+2)) ${FLAG}`,
      `claude -p $(echo $(echo hi)) ${FLAG}`,
      `claude -p $(cat a; cat b) ${FLAG}`,
      `claude -p $(cat a | head) ${FLAG}`,
      `claude -p $(cat a && cat b) ${FLAG}`,
      `claude -p \`cat a; cat b\` ${FLAG}`,
      `$(claude ${FLAG} -p x) && echo done`,
      `claude -p $(echo hi ${FLAG}`,
      // A run that starts inside backquotes ends at the backquote that closes them, so the flag inside counts.
      `echo \`cd x; claude -p x ${FLAG}\``,
      `echo $(echo \`cd x; claude ${FLAG} -p x\`) && echo done`,
      // Backquotes closed before the run starts don't count; the ones it opens hold their text.
      `echo \`x\` && claude -p \`cat a\` ${FLAG}`,
      // Backquotes the run started in that never close run to the end.
      `echo \`cd x; claude -p x ${FLAG}`,
      // A quoted backquote opens nothing.
      `echo "\`"; claude -p x \`cat a\` ${FLAG}`,
      // A backquote starts a command word, as `$(` does.
      `x=\`claude ${FLAG} -p x\``,
      `echo \`claude -p x ${FLAG}\``,
      // An escaped backslash escapes nothing after it; a line continuation joins no word to the agent's.
      `echo \\\\\`claude -p x ${FLAG}\``,
      `echo \\\\;claude -p x ${FLAG}`,
      `echo \\(claude -p x; claude -p y ${FLAG}`,
      `cd x && \\\nclaude -p x ${FLAG}`,
      `cd x;\\\nclaude -p x ${FLAG}`,
      // An escaped backquote inside backquotes opens a nested command substitution.
      `echo \`echo \\\`claude -p x ${FLAG}\\\`\``,
      // A backslash inside the command word is removed: the word is still the agent.
      `/usr/bin\\/claude -p x ${FLAG}`,
      `\\claude -p x ${FLAG}`,
      `c\\laude -p x ${FLAG}`,
      `cd x && \\claude -p x ${FLAG}`,
      `\\claude-code -p x ${FLAG}`,
      // `claude` as an earlier command's argument doesn't hide a later run.
      `echo claude; claude -p y ${FLAG}`,
      // A `#` inside a word, escaped, or on an earlier line starts no comment over the run.
      `echo a#b; claude -p x ${FLAG}`,
      `echo $#; claude -p x ${FLAG}`,
      `echo \\#; claude -p x ${FLAG}`,
      `echo hi # x\nclaude -p x ${FLAG}`,
      // Command position: after a separator, an assignment, a reserved word or a redirect.
      `echo x | claude -p x ${FLAG}`,
      `false || claude -p x ${FLAG}`,
      `cd x\nclaude -p x ${FLAG}`,
      `FOO=1 claude -p x ${FLAG}`,
      `x=$(foo)bar claude -p x ${FLAG}`,
      `x=\`foo\`bar claude -p x ${FLAG}`,
      `if true; then claude -p x ${FLAG}; fi`,
      `for i in 1; do claude -p x ${FLAG}; done`,
      `if false; then :; else claude -p x ${FLAG}; fi`,
      `! claude -p x ${FLAG}`,
      `{ claude -p x ${FLAG}; }`,
      `>out claude -p x ${FLAG}`,
      `2>/dev/null claude -p x ${FLAG}`,
      // After a wrapper, whatever options or values stand between.
      `env FOO=1 claude -p x ${FLAG}`,
      `env -u HOME claude -p x ${FLAG}`,
      `timeout 60 claude -p x ${FLAG}`,
      `nohup claude -p x ${FLAG}`,
      `exec claude -p x ${FLAG}`,
      `command claude -p x ${FLAG}`,
      `time claude -p x ${FLAG}`,
      // The reserved word `time` takes one `-p`, then one `--`, before its command word.
      `time -p claude -p x ${FLAG}`,
      `! time -p claude -p x ${FLAG}`,
      `if time -p claude -p x ${FLAG}; then :; fi`,
      `time -p env claude -p x ${FLAG}`,
      `time -p -- claude -p x ${FLAG}`,
      `time -- claude -p x ${FLAG}`,
      `x=1 time -p claude -p x ${FLAG}`,
      // The `time` program by path is a wrapper.
      `/usr/bin/time -p claude -p x ${FLAG}`,
      `/usr/bin/time -f %e claude -p x ${FLAG}`,
      `echo y | xargs claude -p x ${FLAG}`,
      `sudo -u bob claude -p x ${FLAG}`,
      `pnpm dlx @anthropic-ai/claude-code -p x ${FLAG}`,
      // A `case` pattern's `)` and a function's `()` are followed by a command, as the pattern read them before.
      `case x in a) claude -p x ${FLAG};; esac`,
      `f() { claude -p x ${FLAG}; }; f`,
      `case x in (a) claude -p x ${FLAG};; esac`,
      `function f { claude -p x ${FLAG}; }; f`,
      // The reserved word `coproc`: the word after it is the command word, unless a compound command follows that word,
      // which makes it the coprocess's name.
      `coproc claude -p x ${FLAG}; wait`,
      `coproc { claude -p x ${FLAG}; }; wait`,
      `coproc NAME { claude -p x ${FLAG}; }; wait`,
      `coproc if claude -p x ${FLAG}; then :; fi; wait`,
      `coproc while claude -p x ${FLAG}; do break; done; wait`,
      `coproc NAME while claude -p x ${FLAG}; do break; done; wait`,
      `coproc env claude -p x ${FLAG}`,
      `coproc x=1 claude -p x ${FLAG}`,
      `coproc >/dev/null claude -p x ${FLAG}`,
      `coproc time -p claude -p x ${FLAG}`,
      `coproc /usr/bin/time -f %e claude -p x ${FLAG}`,
      `time coproc claude -p x ${FLAG}`,
      `! coproc claude -p x ${FLAG}`,
      `true && coproc claude -p x ${FLAG}`,
      `coproc ( claude -p x ${FLAG} ); wait`,
      `coproc NAME ( claude -p x ${FLAG} ); wait`,
      // The coprocess's command word is known only at the next word, after any run inside that word.
      `coproc claude $(claude -p y) ${FLAG}`,
      // After an assignment or a redirect, `time` is the `time` program: its options, then its command word.
      `x=1 time -f %e claude -p x ${FLAG}`,
      `>/dev/null time -f %e claude -p x ${FLAG}`,
      `x=1 time -o /dev/null claude -p x ${FLAG}`,
      `x=1 time -v claude -p x ${FLAG}`,
      `x=1 time -a -o /dev/null claude -p x ${FLAG}`,
      `x=1 >/dev/null time --format=%e claude -p x ${FLAG}`,
      `x=1 time -p -f %e claude -p x ${FLAG}`,
      `if true; then x=1 time -f %e claude -p x ${FLAG}; fi`,
      `echo $(x=1 time -f %e claude -p x ${FLAG})`,
      `time -p x=1 time -f %e claude -p x ${FLAG}`,
      // A shell's `-c` string is read as a command: the shell by name or by path, or after a wrapper.
      `bash -c 'claude ${FLAG} -p hi'`,
      `sh -c "claude ${FLAG} -p hi"`,
      `zsh -c 'claude ${FLAG} -p hi'`,
      `dash -c 'claude ${FLAG} -p hi'`,
      `/bin/bash -c 'claude ${FLAG} -p hi'`,
      `/usr/bin/env bash -c 'claude ${FLAG} -p hi'`,
      // The `-c` in a cluster of short options, or among other options.
      `bash -lc 'claude ${FLAG} -p hi'`,
      `bash -ec 'claude ${FLAG} -p hi'`,
      `bash -e -c 'claude ${FLAG} -p hi'`,
      `bash --norc -c 'claude ${FLAG} -p hi'`,
      `bash -o pipefail -c 'claude ${FLAG} -p hi'`,
      `bash -c -- 'claude ${FLAG} -p hi'`,
    ].map((command): [string, string, string, string] => [
      ".claude/settings.json",
      "PreToolUse",
      command,
      FLAG,
    ]),
  ])(
    "reports a hook in %s whose %s command runs the agent with its checks off, on the command's line",
    (path, event, command, kind) => {
      const text = settings({}, hooks(event, command));

      expect(ofRule(path, text, SKIP)).toEqual(onePlace(path, lineWith(text, '"command":'), kind));
    },
  );

  it.each([
    ["runs claude without the flag", 'claude -p "review the diff"'],
    ["greps for the flag with claude in quotes", `grep -q 'claude ${FLAG}' && exit 2 || true`],
    ["runs a command whose name only ends in claude", `myclaude ${FLAG}`],
    [
      "greps for the flag with claude after a space in double quotes",
      `grep -q "run claude ${FLAG}" && exit 2`,
    ],
    [
      "greps for the flag with claude after ;, | and && in double quotes",
      `grep -qE "(^|;|[|]|&&) claude ${FLAG}" && exit 2`,
    ],
    [
      "runs claude without the flag, then greps for it in double quotes after ;",
      `claude -p x; grep -q " claude ${FLAG}"`,
    ],
    ["has the flag only inside the run's own prompt", `claude -p "never pass ${FLAG}"`],
    [
      "runs claude without the flag, then has it in a later command after ;",
      `claude -p x; echo ${FLAG}`,
    ],
    [
      "runs claude without the flag, then has it in a later command after &&",
      `claude -p x && echo ${FLAG}`,
    ],
    [
      "runs claude without the flag, then has it in a later command after |",
      `claude -p x | echo ${FLAG}`,
    ],
    [
      "runs claude without the flag in a group, then has it in a later command after the group's )",
      `(claude -p x) && echo ${FLAG}`,
    ],
    [
      "runs claude without the flag, then has it in a later command after a redirect and ;",
      `claude -p x 2>&1; echo ${FLAG}`,
    ],
    [
      "runs claude without the flag in the background, then has it in a later command after &",
      `claude -p x & echo ${FLAG}`,
    ],
    [
      "runs claude without the flag inside backquotes, then has it in a later command after the closing backquote and &&",
      `echo \`cd x; claude -p x\` && echo ${FLAG}`,
    ],
    [
      "runs claude without the flag inside backquotes, then has it in a later command after the closing backquote and ;",
      `echo \`cd x; claude -p x\`; echo ${FLAG}`,
    ],
    [
      "assigns a backquoted run of claude without the flag, then has it in a later command after ;",
      `x=\`cd x; claude -p x\` ; echo ${FLAG}`,
    ],
    [
      "runs claude without the flag in backquotes inside $(…), then has it in a later command",
      `echo $(echo \`cd x; claude -p x\`) && echo ${FLAG}`,
    ],
    [
      "runs claude without the flag in $(…) inside backquotes, then has it in a later command",
      `echo \`echo $(claude -p x)\` && echo ${FLAG}`,
    ],
    [
      "has an escaped backquote before a run of claude without the flag, then has it in a later command",
      `echo \\\`; claude -p x && echo ${FLAG}`,
    ],
    // An escaped character joins the word, so `claude` after it is no command word.
    ["has an escaped backquote before claude", `echo \\\`claude -p x ${FLAG}`],
    ["has an escaped ( before claude", `echo \\(claude -p x ${FLAG}`],
    ["has an escaped ; before claude", `echo \\;claude -p x ${FLAG}`],
    ["has an escaped & before claude", `echo \\&claude -p x ${FLAG}`],
    ["has an escaped | before claude", `echo \\|claude -p x ${FLAG}`],
    ["has an escaped space before claude", `echo a\\ claude -p x ${FLAG}`],
    ["has an escaped tab before claude", `echo a\\\tclaude -p x ${FLAG}`],
    ["joins a word to claude with a line continuation", `echo a\\\nclaude -p x ${FLAG}`],
    ["has an escaped ( after an escaped backslash", `echo \\\\\\(claude -p x ${FLAG}`],
    ["has an escaped ( before claude inside $(…)", `echo $(echo \\(claude -p x ${FLAG})`],
    ["has an escaped ( before claude-code", `echo \\(claude-code -p x ${FLAG}`],
    [
      "has the flag after an escaped ; and claude, then runs claude without it",
      `echo \\;claude ${FLAG} -p x; claude -p y`,
    ],
    // `claude` as another command's argument.
    ["echoes claude", `echo claude -p x ${FLAG}`],
    ["echoes claude after &&", `cd x && echo claude -p x ${FLAG}`],
    ["greps for claude", `grep claude ${FLAG}`],
    ["reads a file named claude", `cat /usr/bin/claude ${FLAG}`],
    ["echoes a reserved word, then claude", `echo then claude -p x ${FLAG}`],
    ["echoes a wrapper, then claude", `echo env claude -p x ${FLAG}`],
    ["times an echo of claude", `time echo claude -p x ${FLAG}`],
    ["times an echo of claude with -p", `time -p echo claude -p x ${FLAG}`],
    // Bash reads the second `-p` as the command word.
    ["times a command named -p", `time -p -p claude -p x ${FLAG}`],
    // After an assignment or a redirect, a reserved word is a command's name.
    ["times an echo of claude with the time program", `x=1 time -f %e echo claude -p x ${FLAG}`],
    [
      "times an echo of claude with the time program by path",
      `/usr/bin/time -f %e echo claude -p x ${FLAG}`,
    ],
    ["runs a command named ! after an assignment", `x=1 ! claude -p x ${FLAG}`],
    ["runs a command named ! after a redirect", `>/dev/null ! claude -p x ${FLAG}`],
    ["runs a command named { after an assignment", `x=1 { claude -p x ${FLAG}; }`],
    ["runs a command named if after an assignment", `x=1 if claude -p x ${FLAG}; then :; fi`],
    [
      "runs a command named function after an assignment",
      `x=1 function f { claude -p x ${FLAG}; }; f`,
    ],
    [
      "runs a command named function after a redirect",
      `>/dev/null function f { claude -p x ${FLAG}; }; f`,
    ],
    ["runs a command named coproc after an assignment", `x=1 coproc claude -p x ${FLAG}`],
    // `coproc`'s command word is the word after it, unless a compound command makes that word its name.
    ["runs a coprocess command named NAME", `coproc NAME claude -p x ${FLAG}`],
    ["names a coprocess claude", `coproc claude { echo ${FLAG}; }; wait`],
    ["runs a coprocess command named !", `coproc ! claude -p x ${FLAG}`],
    [
      "echoes claude with the flag, then runs claude without it",
      `echo claude ${FLAG}; claude -p y`,
    ],
    ["names a loop variable claude", `for claude in a; do :; done; echo ${FLAG}`],
    // `claude` in a comment.
    ["has claude in a comment after a space", `echo hi # claude -p x ${FLAG}`],
    ["has claude in a comment with no space after #", `echo hi #claude -p x ${FLAG}`],
    ["is only a comment", `# claude -p x ${FLAG}`],
    ["has claude in a comment after ;", `echo hi;# claude -p x ${FLAG}`],
    // A shell's `-c` string keeps the rules above.
    ["greps for the flag through a shell", `bash -c "grep -q -- '${FLAG}' && exit 2 || true"`],
    ["echoes claude with the flag through a shell", `bash -c 'echo claude ${FLAG}'`],
    [
      "has the flag only inside the run's own prompt through a shell",
      `bash -c 'claude -p "never pass ${FLAG}"'`,
    ],
    [
      "runs claude without the flag through a shell, then has it in a later command after ;",
      `bash -c 'claude -p x; echo ${FLAG}'`,
    ],
    // A shell without `c` among its options runs a script, not a string.
    ["runs a shell without -c on a script path", `bash -e 'claude ${FLAG}'`],
    ["runs a shell script with the flag as its argument", `bash script.sh '${FLAG}'`],
  ])("gives nothing for a hook command that %s", (_name, command) => {
    expect(see(".claude/settings.json", settings({}, hooks("PreToolUse", command)))).toEqual([]);
  });

  describe("a hook command a shell runs from its -c string", () => {
    const path = ".claude/settings.json";
    const skips = (command: string) => ofRule(path, settings({}, hooks("Stop", command)), SKIP);
    /** The one Finding of a `Stop` hook running `command`, with one place of `kind`. */
    const onePlaceIn = (command: string, kind = FLAG) =>
      onePlace(path, lineWith(settings({}, hooks("Stop", command)), '"command":'), kind);
    /** A word in double quotes, as a shell reads it back: `"`, `\`, `$` and a backquote escaped. */
    const dq = (text: string) => `"${text.replace(/["\\$`]/g, "\\$&")}"`;
    const sq = (text: string) => `'${text}'`;
    /** A run of the agent with the flag, three shells deep. */
    const threeDeep = `sh -c ${sq(`zsh -c ${dq(`dash -c ${dq(`claude ${FLAG}`)}`)}`)}`;
    /** Four shells deep: `SHELL_LIMIT`'s limit. */
    const fourDeep = `bash -c ${dq(threeDeep)}`;

    it("reports a double-quoted string with escaped quotes once, its prompt not a place", () => {
      const command = `bash -c "claude ${FLAG} -p \\"hi there\\""`;

      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    it.each([
      ["a line continuation", "\n"],
      ["a CRLF line continuation", "\r\n"],
    ])("reports the flag split by %s inside a double-quoted string", (_name, newline) => {
      const split = join("--dangerously", "\\", newline, "-skip-permissions");
      const command = `bash -c "claude '${split}' -p hi"`;

      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    it.each([
      [2, `bash -c "sh -c 'claude ${FLAG}'"`],
      [3, threeDeep],
      [4, fourDeep],
    ])("reports a shell run nested %i deep", (_depth, command) => {
      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    // A shell's own run doesn't hide the runs in its other arguments, which the shell running it executes first.
    it.each([
      `bash script.sh $(claude ${FLAG} -p x)`,
      `bash -c 'echo hi' $(claude ${FLAG} -p x)`,
      `bash <(claude ${FLAG} -p x)`,
      `sh -c "echo" \`claude ${FLAG}\``,
      `zsh script.zsh \`claude ${FLAG} -p x\``,
      `dash script.sh $(claude ${FLAG} -p x)`,
      `env FOO=1 bash script.sh $(claude ${FLAG} -p x)`,
      `env bash <(claude ${FLAG} -p x)`,
      `sudo sh -c "echo" \`claude ${FLAG}\``,
      `sudo bash <(claude ${FLAG} -p x)`,
      `exec bash script.sh $(claude ${FLAG} -p x)`,
      `time bash script.sh \`claude ${FLAG} -p x\``,
    ])("reports a run of the agent among a shell's arguments: %s", (command) => {
      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    const SHELLS = ["sh", "bash", "zsh", "dash"];

    // A shell's name as a wrapper option's value doesn't end the wrapper's search: the agent word after it is the run.
    it.each(
      SHELLS.flatMap((shell) => [
        `env -C /bin/${shell} claude ${FLAG}`,
        `exec -a ${shell} claude ${FLAG}`,
        `sudo -u ${shell} claude ${FLAG}`,
        `xargs -I ${shell} claude ${FLAG}`,
        `npx -p ${shell} claude ${FLAG}`,
        `bunx -p ${shell} claude ${FLAG}`,
        `pnpm -C /bin/${shell} claude ${FLAG}`,
        `yarn --cwd /bin/${shell} claude ${FLAG}`,
      ]),
    )(
      "reports a run of the agent after a shell's name as a wrapper option's value: %s",
      (command) => {
        expect(skips(command)).toEqual(onePlaceIn(command));
      },
    );

    it("reads a wrapped shell's -c string after a shell's name as a wrapper option's value", () => {
      const command = `sudo -u sh bash -c 'claude ${FLAG}'`;

      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    // A wrapped shell running a script named `claude` is reported, as an agent word after a wrapper always is.
    it.each(
      SHELLS.flatMap((shell) => [
        `env ${shell} claude ${FLAG}`,
        `sudo ${shell} claude ${FLAG}`,
        `sudo ${shell} -c x claude ${FLAG}`,
        `command ${shell} claude ${FLAG}`,
        `nohup ${shell} claude ${FLAG}`,
        `nice -n 10 ${shell} claude ${FLAG}`,
        `timeout 60 ${shell} claude ${FLAG}`,
      ]),
    )("reports an agent word after a wrapped shell: %s", (command) => {
      expect(skips(command)).toEqual(onePlaceIn(command));
    });

    it("counts a run in a shell's -c string and one among its arguments as a place each", () => {
      const command = `bash -c 'claude ${FLAG}' $(claude ${FLAG})`;
      const line = lineWith(settings({}, hooks("Stop", command)), '"command":');

      expect(skips(command)).toEqual([
        expect.objectContaining({
          evidence: {
            summary: `2 places skip the agent's permission checks (${FLAG}) in ${path}, first on line ${line}. To fix: ${packRule(SKIP).fix}`,
          },
        }),
      ]);
    });

    it("reads no fifth shell's string, and reports the command as too deep to check", () => {
      // A guard on the test, not the code: the string the fifth shell runs is valid, so only the limit stops it.
      expect(skips(fourDeep)).toEqual(onePlaceIn(fourDeep));
      const fiveDeep = `bash -c ${dq(fourDeep)}`;
      expect(skips(fiveDeep)).toEqual(onePlaceIn(fiveDeep, TOO_DEEP));
    });

    // The limit is per command, nested or not; the agent's own runs are still read past it.
    it.each([
      `bash a.sh; bash b.sh; bash c.sh; bash d.sh; bash e.sh; claude ${FLAG}`,
      `sudo bash bash bash bash bash claude ${FLAG}`,
    ])("reports a fifth shell in %s as too deep to check, beside the agent's run", (command) => {
      const line = lineWith(settings({}, hooks("Stop", command)), '"command":');

      expect(skips(command)).toEqual([
        expect.objectContaining({
          evidence: {
            summary: `2 places may skip the agent's permission checks (${FLAG}, ${TOO_DEEP}) in ${path}, first on line ${line}. To fix: ${packRule(SKIP).fix}`,
          },
        }),
      ]);
    });

    /** A settings file of at most `ARCHIVE_LIMITS.fileBytes` whose one hook is `head`, `unit` repeated, then `tail`. */
    const filled = (head: string, unit: string, tail: string) => {
      const base = settings({}, hooks("Stop", head + tail)).length;
      const perUnit =
        settings({}, hooks("Stop", unit)).length - settings({}, hooks("Stop", "")).length;
      const units = Math.floor((ARCHIVE_LIMITS.fileBytes - base) / perUnit);
      return settings({}, hooks("Stop", head + unit.repeat(units) + tail));
    };

    // On a laptop, main's parser read each of these in 25–55 ms and this one in 30–110 ms, where a read per shell's name
    // took minutes. The limit leaves room for a slow CI runner.
    it.each([
      ["a wrapper then shells' names", filled("sudo ", "bash ", `claude ${FLAG}`)],
      ["a wrapper then shells' -c strings", filled("sudo ", `bash "-c" 'x' `, `claude ${FLAG}`)],
      ["shells after separators", filled("", "bash x;", "")],
      ["shells' strings opening substitutions", filled("", `bash -c "$(`, "")],
      ["a shell's string of quotes and escapes", filled("bash -c '' ", `'a' "b\\"" \\x `, "")],
    ])("reads a 1 MiB hook of %s within a second", (_name, text) => {
      const started = performance.now();
      see(path, text);

      expect(performance.now() - started).toBeLessThan(1000);
    });

    it.each([
      ["no word after -c", "bash -c"],
      ["an empty string", "bash -c ''"],
      ["an unclosed string with no flag", "bash -c 'claude -p x"],
    ])("gives nothing for %s, and doesn't throw", (_name, command) => {
      expect(see(path, settings({}, hooks("Stop", command)))).toEqual([]);
    });

    it("reports an unclosed string that runs the agent with the flag", () => {
      const command = `bash -c 'claude ${FLAG}`;

      expect(skips(command)).toEqual(onePlaceIn(command));
    });
  });

  it.each([
    [
      "a statusLine",
      { statusLine: { type: "command", command: `claude ${FLAG} -p "summarise" --bare` } },
      '"command":',
      FLAG,
    ],
    [
      "a statusLine with padding",
      { statusLine: { type: "command", command: `claude ${FLAG} -p x`, padding: 2 } },
      '"command":',
      FLAG,
    ],
    ["an apiKeyHelper", { apiKeyHelper: `claude ${FLAG} -p key` }, '"apiKeyHelper":', FLAG],
    [
      "a statusLine run through bash -c",
      { statusLine: { type: "command", command: `bash -c 'claude ${FLAG} -p hi'` } },
      '"command":',
      FLAG,
    ],
    [
      "an apiKeyHelper run through bash -c",
      { apiKeyHelper: `bash -c 'claude ${FLAG} -p hi'` },
      '"apiKeyHelper":',
      FLAG,
    ],
  ])(
    "reports %s whose command runs the agent with its checks off, on the command's line",
    (_name, rest, needle, kind) => {
      const path = ".claude/settings.json";
      const text = settings({}, rest);

      expect(ofRule(path, text, SKIP)).toEqual(onePlace(path, lineWith(text, needle), kind));
    },
  );

  it.each([
    [
      "a statusLine that isn't a command",
      { statusLine: { type: "static", command: `claude ${FLAG} -p x` } },
    ],
    ["a statusLine whose command isn't a string", { statusLine: { type: "command", command: 7 } }],
    ["an apiKeyHelper that isn't a string", { apiKeyHelper: [`claude ${FLAG}`] }],
  ])("gives nothing for %s", (_name, rest) => {
    expect(see(".claude/settings.json", settings({}, rest))).toEqual([]);
  });

  it("counts a hook, a statusLine and an apiKeyHelper that each run the flag as 3 places, first on the earliest line", () => {
    const text = settings(
      {},
      {
        apiKeyHelper: `claude ${FLAG} -p key`,
        statusLine: { type: "command", command: `claude ${FLAG} -p status` },
        ...hooks("Stop", `claude ${FLAG} -p x`),
      },
    );
    const first = lineWith(text, '"apiKeyHelper":');

    expect(ofRule(".claude/settings.json", text, SKIP)).toEqual([
      expect.objectContaining({
        location: { kind: "file", path: ".claude/settings.json", line: first },
        evidence: {
          summary: `3 places skip the agent's permission checks (${FLAG}) in .claude/settings.json, first on line ${first}. To fix: ${packRule(SKIP).fix}`,
        },
      }),
    ]);
  });

  it("counts defaultMode bypass and a hook that runs the flag as 2 places in one Observation, first on the earlier line", () => {
    const text = settings({ defaultMode: BYPASS }, hooks("Stop", `claude ${FLAG} -p x`));

    expect(ofRule(".claude/settings.json", text, SKIP)).toEqual([
      expect.objectContaining({
        location: { kind: "file", path: ".claude/settings.json", line: 4 },
        evidence: {
          summary: `2 places skip the agent's permission checks (defaultMode ${BYPASS} (applies before Claude Code v2.1.257), ${FLAG}) in .claude/settings.json, first on line 4. To fix: ${packRule(SKIP).fix}`,
        },
      }),
    ]);
  });
});

describe("a settings file that starts with a byte order mark", () => {
  const BOM = String.fromCharCode(0xfeff);

  it("is read without it, its lines counted as before", () => {
    const text = `${BOM}{\n  "permissions": {\n    "allow": ["Bash(*)"]\n  }\n}\n`;

    expect(ofRule(".claude/settings.json", text, BLANKET).map((o) => o.location)).toEqual([
      { kind: "file", path: ".claude/settings.json", line: 3 },
    ]);
  });

  it("has its root deny of .env read, stopping guard/agent-can-read-env", () => {
    const text = `${BOM}${settings({ deny: ["Read(./.env)"] })}`;

    // Its one deny entry also stops guard/no-runtime-guard.
    expect(endOf([CLAUDE_MD, { path: ".claude/settings.json", text }])).toEqual([]);
  });
});

describe("the whole-repo Rules, at the end of a repo", () => {
  it("gives guard/agent-can-read-env and guard/no-runtime-guard for a repo with CLAUDE.md and no settings file", () => {
    const observations = endOf([CLAUDE_MD, { path: "src/index.ts", text: "export {};\n" }]);

    expect(observations).toEqual([
      {
        asset: repo,
        rule_id: READ_ENV,
        location: { kind: "file", path: ".claude/settings.json" },
        severity: "high",
        title: "The agent can read .env files",
        evidence: {
          summary: `No permissions.deny rule in .claude/settings.json or .claude/settings.local.json stops the agent reading .env. To fix: ${packRule(READ_ENV).fix}`,
        },
      },
      {
        asset: repo,
        rule_id: NO_GUARD,
        location: { kind: "file", path: ".claude/settings.json" },
        severity: "medium",
        title: "Nothing checks the agent's tool calls",
        evidence: {
          summary: `Nothing checks the agent's tool calls: no permissions.deny rule and no PreToolUse hook in .claude/settings.json or .claude/settings.local.json. To fix: ${packRule(NO_GUARD).fix}`,
        },
      },
    ]);
    for (const observation of observations ?? []) {
      expect(Observation.safeParse(observation).success).toBe(true);
    }
  });

  it.each([
    ["a .claude/ path", ".claude/agents/reviewer.md"],
    ["a .claude/ path in a subfolder", "apps/web/.claude/commands/ship.md"],
    [".mcp.json in a subfolder", "packages/api/.mcp.json"],
    ["CLAUDE.md in a subfolder", "docs/CLAUDE.md"],
  ])("gives both for a repo whose only sign of Claude Code is %s", (_name, path) => {
    expect(ruleIds(endOf([{ path, text: "{}\n" }]))).toEqual([READ_ENV, NO_GUARD]);
  });

  it("counts an unread path as a sign of Claude Code", () => {
    expect(ruleIds(endOf([], ["docs/CLAUDE.md"]))).toEqual([READ_ENV, NO_GUARD]);
  });

  it("gives neither for a repo with no .claude path, no CLAUDE.md and no .mcp.json", () => {
    const files = [
      { path: "README.md", text: "# App\n" },
      { path: "claude/settings.json", text: "{}\n" },
      { path: "src/claude.ts", text: "export {};\n" },
      { path: "docs/CLAUDE.md.bak", text: "old\n" },
      { path: ".claudeignore", text: ".env\n" },
    ];

    expect(endOf(files)).toEqual([]);
  });

  it.each(
    [
      "Read",
      "Read(./.env)",
      "Read(.env)",
      "Read(**/.env)",
      "Read(./.env*)",
      "Read(/.env)",
      "Read(//**/.env)",
      "Read(./**/.env)",
      "Read(./**/.env*)",
      "Read(/**/.env)",
      "Read(/**/.env*)",
    ].flatMap((entry) => [
      [entry, ".claude/settings.json"],
      [entry, ".claude/settings.local.json"],
    ]),
  )("a root deny of %s in %s stops guard/agent-can-read-env", (entry, path) => {
    const observations = endOf([CLAUDE_MD, { path, text: settings({ deny: [entry] }) }]);

    expect(ruleIds(observations)).not.toContain(READ_ENV);
  });

  it.each([
    ["Read(./.env.*) alone", ".claude/settings.json", ["Read(./.env.*)"]],
    ["Read(./**/.env.*) alone", ".claude/settings.json", ["Read(./**/.env.*)"]],
    ["Read(./.env) only in a subfolder's settings", "sub/.claude/settings.json", ["Read(./.env)"]],
    ["a deny of other files", ".claude/settings.json", ["Read(./secrets/**)", "Read(./.envrc)"]],
    ["a deny of another tool on .env", ".claude/settings.json", ["Edit(./.env)"]],
  ])("still gives guard/agent-can-read-env with %s", (_name, path, deny) => {
    const observations = endOf([CLAUDE_MD, { path, text: settings({ deny }) }]);

    expect(ruleIds(observations)).toContain(READ_ENV);
  });

  it.each([
    [".claude/settings.json", settings({ deny: ["Bash(rm *)"] })],
    [".claude/settings.local.json", settings({ deny: ["WebFetch"] })],
    [".claude/settings.json", settings({}, hooks("PreToolUse", ".claude/hooks/guard.sh"))],
    [".claude/settings.local.json", settings({}, hooks("PreToolUse", "node scripts/guard.js"))],
  ])(
    "a root deny entry or PreToolUse hook command in %s stops guard/no-runtime-guard",
    (path, text) => {
      expect(ruleIds(endOf([CLAUDE_MD, { path, text }]))).not.toContain(NO_GUARD);
    },
  );

  it.each([
    [
      "a PostToolUse hook alone",
      ".claude/settings.json",
      settings({}, hooks("PostToolUse", "pnpm lint")),
    ],
    [
      "a PreToolUse hook only in a subfolder's settings",
      "apps/web/.claude/settings.json",
      settings({ deny: ["Bash(rm *)"] }, hooks("PreToolUse", ".claude/hooks/guard.sh")),
    ],
    [
      "a PreToolUse hook that isn't a command",
      ".claude/settings.json",
      settings(
        {},
        {
          hooks: {
            PreToolUse: [{ hooks: [{ type: "http", url: "http://localhost:8080/guard" }] }],
          },
        },
      ),
    ],
    [
      "a deny that isn't a list of strings",
      ".claude/settings.json",
      settings({ deny: [42, { rule: "Read" }] }),
    ],
  ])("still gives guard/no-runtime-guard with %s", (_name, path, text) => {
    expect(ruleIds(endOf([CLAUDE_MD, { path, text }]))).toContain(NO_GUARD);
  });

  it("reads the two root settings files together, as Claude Code merges them", () => {
    const files = [
      CLAUDE_MD,
      { path: ".claude/settings.json", text: settings({}, hooks("PreToolUse", "guard.sh")) },
      { path: ".claude/settings.local.json", text: settings({ deny: ["Read(./.env)"] }) },
    ];

    expect(endOf(files)).toEqual([]);
  });

  it("gives both for a root .claude/settings.json that isn't valid JSON, and throws nothing", () => {
    const files = [
      { path: ".claude/settings.json", text: '{\n  "permissions": { "deny": ["Read",] }\n}\n' },
    ];

    expect(() => endOf(files)).not.toThrow();
    expect(ruleIds(endOf(files))).toEqual([READ_ENV, NO_GUARD]);
  });

  it.each([".claude/settings.json", ".claude/settings.local.json"])(
    "answers undefined once %s is reported unread",
    (path) => {
      expect(endOf([CLAUDE_MD], [path])).toBeUndefined();
    },
  );

  it.each(["apps/web/.claude/settings.json", "assets/logo.png"])(
    "still answers once %s, not a root settings file, is reported unread",
    (path) => {
      expect(ruleIds(endOf([CLAUDE_MD], [path]))).toEqual([READ_ENV, NO_GUARD]);
    },
  );
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
