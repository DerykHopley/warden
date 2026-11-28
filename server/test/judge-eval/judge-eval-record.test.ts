// The recorder behind `pnpm eval:record` (#512): it runs a real `claude -p` session on a Seeded org repo and keeps its
// hook bodies as an ordinary eval case. Here a stub `claude` on PATH stands in for Claude Code: it reads the
// `--settings` file it is given and runs each command hook with a hook body on stdin, as Claude Code does
// (https://code.claude.com/docs/en/hooks), so no model runs.
import {
  chmodSync,
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
import { AWS_KEY, STRIPE_KEY } from "../secret-fixtures.ts";
import { loadEvalCases } from "./eval-cases.ts";
import { ALLOWED_TOOLS, parseRecordArgs, recordCase, type RecordOptions } from "./record.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Claude Code stand-in. STUB_MODE picks how the session goes; STUB_LOG gets the args, cwd, files and settings. */
const STUB = `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({
  args, cwd: process.cwd(), files: fs.readdirSync(process.cwd(), { recursive: true }), settings,
}));
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const fire = (event, body) => {
  for (const group of settings.hooks[event] ?? []) for (const hook of group.hooks) {
    execSync(hook.command, { input: JSON.stringify({
      session_id: "7f1e0c2a-sid",
      transcript_path: (process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME + "/.claude") + "/projects/" + slug + "/7f1e0c2a-sid.jsonl",
      cwd: process.cwd(), permission_mode: "default", hook_event_name: event, ...body,
    }) });
  }
};
const mode = process.env.STUB_MODE;
fire("UserPromptSubmit", { prompt: args[args.indexOf("-p") + 1] });
fire("PostToolUse", {
  tool_name: "Read", tool_use_id: "toolu_1",
  tool_input: { file_path: process.cwd() + "/src/config.ts" },
  tool_response: { file: { content: "key ${AWS_KEY} and ${STRIPE_KEY}; notes in /var/home/alice/notes by alice, not alicesmith" } },
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
    env: { PATH: bin, HOME: "/var/home/alice", STUB_LOG: log, STUB_MODE: "ok" },
    ...overrides,
  };
}

const stubLog = () =>
  JSON.parse(readFileSync(log, "utf8")) as {
    args: string[];
    cwd: string;
    files: string[];
    settings: { hooks: Record<string, { hooks: { type: string; command: string }[] }[]> };
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
    // Locked down: anything off the tool list is denied, and the repo's own settings and MCP servers (the Seeded
    // org's misconfigurations) never load.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual([...ALLOWED_TOOLS]);
    expect(ALLOWED_TOOLS).not.toContain("Bash");
    expect(ALLOWED_TOOLS.filter((tool) => /^Bash\(\*?\)$/.test(tool))).toEqual([]);
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
    // The loader refuses it until the author sets the two, and then loads it.
    expect(() => loadEvalCases(casesDir)).toThrow(/"ordinary-docs-typo"/);
    const edited = { ...JSON.parse(written()), split: "dev", stands_for: "ordinary work" };
    writeFileSync(join(casesDir, "ordinary-docs-typo.json"), JSON.stringify(edited));
    const [loaded] = loadEvalCases(casesDir);
    expect(loaded!.events.at(-1)!.hook_event_name).toBe("SessionEnd");
  });

  it("drops session_id and rewrites the folder, home, user and planted secrets", async () => {
    await recordCase(options());
    const text = written();
    expect(text).not.toContain("session_id");
    expect(text).toContain('"/home/dev/project/src/config.ts"');
    expect(text).toContain('"/home/dev/.claude/projects/-home-dev-project/7f1e0c2a-sid.jsonl"');
    expect(text).toContain("notes in /home/dev/notes by dev, not alicesmith");
    expect(text).toContain("key {{AWS_KEY}} and {{STRIPE_KEY}}");
    for (const leak of [AWS_KEY, STRIPE_KEY, "/var/home/alice", root])
      expect(text).not.toContain(leak);
    expect(text).not.toMatch(/(?<![A-Za-z0-9])alice(?![A-Za-z0-9])/);
  });

  it("rewrites a Claude config folder set by CLAUDE_CONFIG_DIR to dev's ~/.claude", async () => {
    const env = { ...options().env, CLAUDE_CONFIG_DIR: "/var/home/alice/.claude-work" };
    await recordCase(options({ env }));
    const text = written();
    expect(text).toContain('"/home/dev/.claude/projects/-home-dev-project/7f1e0c2a-sid.jsonl"');
    expect(text).not.toContain(".claude-work");
  });

  it("removes its throwaway folder", async () => {
    await recordCase(options());
    expect(readdirSync(work)).toEqual([]);
  });

  it("keeps a session cut by its turn cap, which still ends with SessionEnd", async () => {
    await recordCase(options({ env: { ...options().env, STUB_MODE: "max-turns" } }));
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
    await expect(
      recordCase(options({ env: { ...options().env, STUB_MODE: "exit1" } })),
    ).rejects.toThrow(/claude exited with code 1/);
    expect(readdirSync(casesDir)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("writes nothing when no SessionEnd was captured, and says so", async () => {
    await expect(
      recordCase(options({ env: { ...options().env, STUB_MODE: "no-session-end" } })),
    ).rejects.toThrow(/no SessionEnd/);
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
