// The recorder behind `pnpm eval:record` (#512): it runs a real `claude -p` session on a Seeded org repo and keeps its
// hook bodies as an ordinary eval case. Here a stub `claude` on PATH stands in for Claude Code: it reads the
// `--settings` file it is given and runs each command hook with a hook body on stdin, as Claude Code does
// (https://code.claude.com/docs/en/hooks), so no model runs.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../child-process.ts";
import { AWS_KEY, RSA_PRIVATE_KEY, STRIPE_KEY } from "../secret-fixtures.ts";
import { FIXTURE_SECRETS } from "./eval-cases.ts";
import {
  ALLOWED_TOOLS,
  DEV_SESSION_ID,
  caseLeak,
  parseRecordArgs,
  recordCase,
  type RecordOptions,
  userWord,
} from "./record.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** A GitHub-shaped token that isn't a secret-fixtures.ts export, so only Guard's secret patterns can catch it. */
const FOREIGN_TOKEN = ["ghp", "_", "k9Lm2Np4Qr6St8Uv0Wx1Yz3Ab5Cd7Ef9Gh1J"].join("");

/** The scratchpad root Claude Code writes under on this machine, with no TMPDIR passed to it. */
const CLAUDE_TMP = `/tmp/claude-${process.getuid!()}`;

/** What `whoami`, `ls -l` and `git log` print for the user alice: her name as a bare word, outside any path. */
const BASH_OUTPUT =
  "alice\n-rw-r--r--. 1 alice alice 12 Nov 28 README.md\nAuthor: Alice <ALICE@example.com>";

/** Claude Code stand-in. The `stub-mode` file beside its folder picks how the session goes; `stub-log.json` there
 * gets the args, cwd, files, settings and environment it ran with. It reads neither from its environment, so the
 * test sees the environment exactly as the recorder passes it. */
const STUB = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const here = path.dirname(path.dirname(__filename));
const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
fs.writeFileSync(path.join(here, "stub-log.json"), JSON.stringify({
  args, cwd: process.cwd(), files: fs.readdirSync(process.cwd(), { recursive: true }), settings, env: process.env,
}));
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const sid = "7f1e0c2a-sid";
const fire = (event, body) => {
  for (const group of settings.hooks[event] ?? []) for (const hook of group.hooks) {
    execSync(hook.command, { input: JSON.stringify({
      session_id: sid,
      transcript_path: (process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME + "/.claude") + "/projects/" + slug + "/" + sid + ".jsonl",
      cwd: process.cwd(),
      scratchpad_dir: require("node:os").tmpdir() + "/claude-" + process.getuid() + "/" + slug + "/" + sid + "/scratchpad",
      permission_mode: "default", hook_event_name: event, ...body,
    }) });
  }
};
const mode = fs.existsSync(path.join(here, "stub-mode")) ? fs.readFileSync(path.join(here, "stub-mode"), "utf8") : "ok";
fire("UserPromptSubmit", { prompt: args[args.indexOf("-p") + 1] });
fire("PostToolUse", {
  tool_name: "Read", tool_use_id: "toolu_1",
  tool_input: { file_path: process.cwd() + "/src/config.ts" },
  tool_response: { file: { content: ${JSON.stringify(
    `key ${AWS_KEY} and ${STRIPE_KEY}; notes in /var/home/alice/notes by alice, not alicesmith; cache in /srv/alice/cache\n${RSA_PRIVATE_KEY}`,
  )} + (mode === "foreign-secret" ? ${JSON.stringify(` and ${FOREIGN_TOKEN}`)} : "") } },
});
fire("PostToolUse", {
  tool_name: "Bash", tool_use_id: "toolu_2",
  tool_input: { command: "whoami && ls -l README.md && git log -1" },
  tool_response: { stdout: ${JSON.stringify(BASH_OUTPUT)}, stderr: "", interrupted: false },
});
if (mode !== "no-session-end") fire("SessionEnd", { reason: "other" });
if (mode === "exit1") { process.stderr.write("boom"); process.exit(1); }
if (mode === "max-turns") { process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns" })); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }));
`;

let root: string;
let bin: string;
let casesDir: string;
let work: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warden-record-test-"));
  bin = join(root, "bin");
  casesDir = join(root, "cases");
  work = join(root, "work");
  for (const dir of [bin, casesDir, work]) mkdirSync(dir);
  writeFileSync(join(bin, "claude"), STUB);
  chmodSync(join(bin, "claude"), 0o755);
  log = join(root, "stub-log.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** How the stub's session goes: "ok", "exit1", "max-turns", "no-session-end" or "foreign-secret". */
const stubMode = (mode: string) => writeFileSync(join(root, "stub-mode"), mode);

function options(overrides: Partial<RecordOptions> = {}): RecordOptions {
  return {
    caseName: "ordinary-docs-typo",
    repoName: "billing-api",
    tier: "content",
    length: "medium",
    task: "Fix the typo in the README.",
    casesDir,
    workParent: work,
    home: "/var/home/alice",
    user: "alice",
    env: { PATH: bin, HOME: "/var/home/alice" },
    ...overrides,
  };
}

const stubLog = () =>
  JSON.parse(readFileSync(log, "utf8")) as {
    args: string[];
    cwd: string;
    files: string[];
    env: Record<string, string>;
    settings: {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
      permissions?: Record<string, unknown>;
    };
  };
const written = (name = "ordinary-docs-typo") =>
  readFileSync(join(casesDir, `${name}.json`), "utf8");

describe("recordCase", () => {
  it("runs claude -p on the repo's files with haiku, the length's turn cap, command hooks and a fixed tool list", async () => {
    await recordCase(options());
    const { args, files, settings } = stubLog();
    expect(args.slice(0, 2)).toEqual(["-p", "Fix the typo in the README."]);
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("4");
    // What's locked down: a call needing approval is denied unless a rule here pre-approves it; the file tools and
    // read-only commands stay in the project; the repo's own settings and MCP servers (the Seeded org's
    // misconfigurations) never load. What isn't: the user's own settings load, so their hooks and mods can still
    // approve a call this would deny.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
    expect(settings.permissions).toEqual({
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    });
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual([...ALLOWED_TOOLS]);
    // Each rule a file rule scoped to the project: no bare tool, which would reach past it, and no Bash rule, which
    // could run a program (node, an npm script) that no rule limits.
    for (const tool of ALLOWED_TOOLS) expect(tool).toMatch(/^(Read|Edit)\(\.\/\*\*\)$/);
    for (const flag of args) expect(flag).not.toMatch(/skip-permissions|bypassPermissions/);
    expect(files).toContain("src/config.ts");
    // The tier's events, as the managed-settings block sends them, each a command hook.
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ["PostToolUse", "PostToolUseFailure", "SessionEnd", "UserPromptSubmit"].sort(),
    );
    for (const groups of Object.values(settings.hooks))
      for (const group of groups) for (const hook of group.hooks) expect(hook.type).toBe("command");
  });

  it("hooks only the events the tier sends: no UserPromptSubmit below content", async () => {
    await recordCase(options({ tier: "metadata", length: "short" }));
    const { args, settings } = stubLog();
    expect(args[args.indexOf("--max-turns") + 1]).toBe("2");
    expect(Object.keys(settings.hooks)).not.toContain("UserPromptSubmit");
    expect(written()).not.toContain("UserPromptSubmit");
  });

  it("writes an ordinary, recorded case labelled clean, with split and stands_for left for the author", async () => {
    const file = await recordCase(options({ length: "long" }));
    expect(file).toBe(join(casesDir, "ordinary-docs-typo.json"));
    expect(JSON.parse(written())).toMatchObject({
      name: "ordinary-docs-typo",
      description: "Fix the typo in the README.",
      group: "ordinary",
      split: null,
      tier: "content",
      labels: [],
      stands_for: null,
      source: "recorded",
      length: "long",
    });
    expect(stubLog().args[stubLog().args.indexOf("--max-turns") + 1]).toBe("8");
  });

  it("runs claude with only PATH, HOME, TERM, the config folder and proxy settings, in the C locale", async () => {
    const env = {
      ...options().env,
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      CLAUDE_CONFIG_DIR: "/var/home/alice/.claude-work",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      no_proxy: "localhost",
      ANTHROPIC_API_KEY: "pay-per-token",
      ANTHROPIC_AUTH_TOKEN: "token",
      GITHUB_TOKEN: "token",
      DATABASE_URL: "postgres://u:p@h/db",
      TMPDIR: "/var/tmp/alice",
    };
    await recordCase(options({ env }));
    expect(stubLog().env).toEqual({
      PATH: bin,
      HOME: "/var/home/alice",
      TERM: "xterm",
      LANG: "C",
      LC_ALL: "C",
      CLAUDE_CONFIG_DIR: "/var/home/alice/.claude-work",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      no_proxy: "localhost",
    });
  });

  it("drops session_id and rewrites the folders, home, the user's name and every secret-fixtures export", async () => {
    await recordCase(options());
    const text = written();
    expect(text).not.toContain("session_id");
    expect(text).toContain('"/home/dev/project/src/config.ts"');
    expect(text).toContain(
      `"/home/dev/.claude/projects/-home-dev-project/${DEV_SESSION_ID}.jsonl"`,
    );
    // The user's name is rewritten as a whole word, in paths and prose alike; a longer word holding it stays.
    expect(text).toContain("notes in /home/dev/notes by dev, not alicesmith");
    expect(text).toContain("cache in /srv/dev/cache");
    expect(text).toContain("key {{AWS_KEY}} and {{STRIPE_KEY}}");
    expect(text).toContain("{{RSA_PRIVATE_KEY}}");
    for (const leak of [AWS_KEY, STRIPE_KEY, RSA_PRIVATE_KEY, "/var/home/alice", "/alice/", root])
      expect(text).not.toContain(leak);
  });

  it("rewrites the user's name to dev in a tool's output, where it isn't in a path", async () => {
    await recordCase(options());
    const text = written();
    expect(text).toContain(
      JSON.stringify(
        "dev\n-rw-r--r--. 1 dev dev 12 Nov 28 README.md\nAuthor: dev <dev@example.com>",
      ),
    );
    // In any casing: a git author or an e-mail can spell the name otherwise (#518).
    expect(text).not.toMatch(/\balice\b/i);
  });

  it("rewrites Claude's scratchpad root and the session id in it to dev's", async () => {
    await recordCase(options());
    const text = written();
    expect(text).toContain(
      `"scratchpad_dir": "/tmp/claude-dev/-home-dev-project/${DEV_SESSION_ID}/scratchpad"`,
    );
    expect(text).not.toContain(CLAUDE_TMP);
    expect(text).not.toContain("7f1e0c2a-sid");
  });

  it("rewrites a Claude config folder set by CLAUDE_CONFIG_DIR to dev's ~/.claude", async () => {
    const env = { ...options().env, CLAUDE_CONFIG_DIR: "/var/home/alice/.claude-work" };
    await recordCase(options({ env }));
    const text = written();
    expect(text).toContain(
      `"/home/dev/.claude/projects/-home-dev-project/${DEV_SESSION_ID}.jsonl"`,
    );
    expect(text).not.toContain(".claude-work");
  });

  it("writes nothing when the case still holds a secret Guard's patterns find", async () => {
    stubMode("foreign-secret");
    await expect(recordCase(options())).rejects.toThrow(/GitHub token.*no case was written/);
    expect(readdirSync(casesDir)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it.each([
    ["root", "/root"],
    ["node", "/home/node"],
    ["runner", "/home/runner"],
    ["alice", "/home/admin"],
    ["user", "/home/alice"],
    // A Claude Code tool's name, which a case-blind rewrite would turn into dev in every tool_name (#520).
    ["bash", "/home/bash"],
    ["Read", "/home/Read"],
  ])(
    "refuses to record as the generic user %s with home %s, before running claude",
    async (user, home) => {
      await expect(recordCase(options({ user, home }))).rejects.toThrow(/generic/);
      expect(existsSync(log)).toBe(false);
      expect(readdirSync(work)).toEqual([]);
    },
  );

  it("removes its throwaway folder", async () => {
    await recordCase(options());
    expect(readdirSync(work)).toEqual([]);
  });

  it("keeps a session cut by its turn cap, which still ends with SessionEnd", async () => {
    stubMode("max-turns");
    await recordCase(options());
    expect(JSON.parse(written()).events.at(-1).hook_event_name).toBe("SessionEnd");
  });

  it("stops before creating anything when claude isn't on PATH, naming the command", async () => {
    await expect(
      recordCase(options({ env: { ...options().env, PATH: casesDir } })),
    ).rejects.toThrow(/`claude`.*PATH/);
    expect(readdirSync(casesDir)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("writes nothing when claude exits non-zero, and says so", async () => {
    stubMode("exit1");
    await expect(recordCase(options())).rejects.toThrow(/claude exited with code 1.*boom/);
    expect(readdirSync(casesDir)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("writes nothing when no SessionEnd was captured, and says so", async () => {
    stubMode("no-session-end");
    await expect(recordCase(options())).rejects.toThrow(/no SessionEnd/);
    expect(readdirSync(casesDir)).toEqual([]);
  });

  it("refuses to overwrite a case that's already there", async () => {
    writeFileSync(join(casesDir, "ordinary-docs-typo.json"), "{}");
    await expect(recordCase(options())).rejects.toThrow(/already/);
    expect(written()).toBe("{}");
  });

  it("refuses a repo outside the Seeded org", async () => {
    await expect(recordCase(options({ repoName: "no-such-repo" }))).rejects.toThrow(
      /"no-such-repo"/,
    );
  });
});

it("userWord builds a regex when passed the i flag itself (#520)", () => {
  expect(userWord("alice", "i").test("ALICE")).toBe(true);
});

describe("caseLeak", () => {
  const from = {
    folders: ["/var/home/alice", CLAUDE_TMP],
    sessionIds: ["7f1e0c2a-sid"],
    user: "alice",
  };

  it.each([...FIXTURE_SECRETS])("finds the secret-fixtures export %s", (name, secret) => {
    expect(caseLeak(`a ${secret} b`, from)).toContain(name);
  });

  it.each([
    ["a folder", "/var/home/alice/x", /\/var\/home\/alice/],
    ["Claude's scratchpad root", `${CLAUDE_TMP}/-home-dev-project/x`, /claude-/],
    ["the session id", "/home/dev/.claude/projects/p/7f1e0c2a-sid.jsonl", /session/],
    ["the user in a path", "/srv/alice/cache", /alice/],
    ["the user's name in a tool's output", "Author: alice <alice@example.com>", /alice/],
    ["the user's name in another casing", "USER=ALICE", /alice/i],
    ["a secret only Guard's patterns find", `x ${FOREIGN_TOKEN}`, /GitHub token/],
  ])("finds %s", (_what, text, found) => {
    expect(caseLeak(text, from)).toMatch(found);
  });

  it("finds nothing in dev's text, a longer word holding the user's name included", () => {
    expect(
      caseLeak("/home/dev/project by dev, not alicesmith; /tmp/claude-dev/x {{AWS_KEY}}", from),
    ).toBeNull();
  });
});

describe("parseRecordArgs", () => {
  it("reads <case-name> <repo-name> <tier> <length> <task>, after pnpm's --", () => {
    expect(
      parseRecordArgs(["--", "ordinary-1", "docs-site", "details", "short", "Fix a typo"]),
    ).toEqual({
      caseName: "ordinary-1",
      repoName: "docs-site",
      tier: "details",
      length: "short",
      task: "Fix a typo",
    });
  });

  it.each([
    [["ordinary-1", "docs-site", "details", "short"]],
    [["ordinary-1", "docs-site", "secret", "short", "task"]],
    [["ordinary-1", "docs-site", "details", "huge", "task"]],
    [["Ordinary 1", "docs-site", "details", "short", "task"]],
  ])("refuses %j with the usage line", (args) => {
    expect(() => parseRecordArgs(args)).toThrow(/usage: pnpm --filter @warden\/server eval:record/);
  });
});

describe("pnpm eval:record", () => {
  it("exits 1 naming claude when it isn't on PATH, and writes no case", async () => {
    const before = readdirSync(new URL("../session-fixtures/eval/", import.meta.url));
    const { code, output } = await runCommand(
      [
        process.execPath,
        "test/judge-eval/record.ts",
        "--",
        "ordinary-x",
        "docs-site",
        "metadata",
        "short",
        "t",
      ],
      { PATH: casesDir },
      { cwd: SERVER_DIR, clean: true },
    );
    expect(code).toBe(1);
    expect(output).toMatch(/`claude`/);
    expect(readdirSync(new URL("../session-fixtures/eval/", import.meta.url))).toEqual(before);
  });
});
