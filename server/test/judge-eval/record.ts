// Records one ordinary eval case (#512): `pnpm --filter @warden/server eval:record -- <case-name> <repo-name> <tier>
// <length> "<task>"`. It writes a Seeded org repo's files to a throwaway folder, runs a real `claude -p` session there
// on the Claude subscription, catches each hook body Claude Code sends through command hooks, and writes the bodies
// as a case in the eval folder: labelled clean, with its split and stands_for left for the author to set.
//
// Claude Code's flags and hooks: https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/hooks
// and https://code.claude.com/docs/en/headless. The session runs in the dontAsk permission mode
// (https://code.claude.com/docs/en/permission-modes), never a permission-skip flag or mode, with the project's file
// rules in `ALLOWED_TOOLS` (https://code.claude.com/docs/en/permissions). The user's own settings still load, so this
// limits the session but doesn't sandbox it: see the `--setting-sources` flag below.
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivacyTier } from "@warden/contracts";
import { managedSettings } from "../../src/modules/guard/managed-settings.ts";
import { findSecrets } from "../../src/modules/guard/secrets.ts";
import { runCommand } from "../child-process.ts";
import { SEEDED_ORG } from "../seeded-org.ts";
import {
  CASE_LENGTHS,
  EVAL_CASES_DIR,
  FIXTURE_SECRETS,
  TURN_CAPS,
  mapStrings,
  type CaseLength,
} from "./eval-cases.ts";

const USAGE =
  'usage: pnpm --filter @warden/server eval:record -- <case-name> <repo-name> <metadata|details|content> <short|medium|long> "<task>"';

/** The tools the session may use without asking: reading and editing files inside the project, as gitignore-style
 * paths from its folder. Edit's rule covers every built-in tool that changes a file, Write included. Claude Code also
 * lets a few read-only tools (Glob, Grep, and commands such as `ls`, `cat` and `wc`) run without a rule; the settings'
 * `blockReadsOutsideWorkingDirectories` keeps those to the project. There's no Bash rule: a program it ran (node, an
 * npm script the session wrote) would reach wherever it liked. */
export const ALLOWED_TOOLS: readonly string[] = ["Read(./**)", "Edit(./**)"];

/** Where the session seems to run, in the case: a developer `dev` with the project in their home folder. */
const DEV_HOME = "/home/dev";
const DEV_PROJECT = `${DEV_HOME}/project`;
const DEV_USER = "dev";
/** Claude Code's scratchpad root as dev's, in place of the recording machine's `<tmpdir>/claude-<uid>`. */
const DEV_CLAUDE_TMP = "/tmp/claude-dev";
/** The session id the case names in its transcript and scratchpad paths, in place of the recorded one. */
export const DEV_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/** User and home folder names a case can't be cleaned of: they stand for many machines, and are ordinary words. */
const GENERIC_NAMES = new Set(["root", "node", "runner", "admin", "user"]);
/** Whether `name` is empty or one of the generic user names, which the recorder refuses to record as. */
export const isGenericName = (name: string) => !name || GENERIC_NAMES.has(name.toLowerCase());

/** The variables `claude` keeps from the recording environment: where to find it and its config, the terminal, and
 * how it reaches Anthropic (a base URL or proxy, such as one that traces the session). Nothing else passes: not
 * ANTHROPIC_API_KEY, so a recording stays on the subscription and never turns into a pay-per-token run, nor any other
 * token or secret. */
const PASSED_VARIABLES = [
  "PATH",
  "HOME",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [
    name,
    name.toLowerCase(),
  ]),
];

/** The hook script each command hook runs: it appends the hook body from stdin to the capture file, one per line. */
const CAPTURE_SCRIPT = `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify(JSON.parse(readFileSync(0, "utf8"))) + "\\n");
`;

export type RecordArgs = {
  caseName: string;
  repoName: string;
  tier: PrivacyTier;
  length: CaseLength;
  task: string;
};

export type RecordOptions = RecordArgs & {
  /** The eval folder the case goes in. */
  casesDir?: string;
  /** Where the throwaway folder is made. */
  workParent?: string;
  /** The environment `claude` is found on, and the variables in `PASSED_VARIABLES` it runs with. */
  env?: NodeJS.ProcessEnv;
  /** The recording machine's home folder and user name, rewritten out of the case. */
  home?: string;
  user?: string;
  /** Claude Code's scratchpad root on this machine, rewritten out of the case. */
  claudeTmp?: string;
};

const CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The CLI's arguments, after the `--` pnpm passes on. Throws the usage line for anything else. */
export function parseRecordArgs(argv: readonly string[]): RecordArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [caseName, repoName, tier, length, task] = args;
  const tierOk = PrivacyTier.safeParse(tier).success;
  const lengthOk = (CASE_LENGTHS as readonly string[]).includes(length ?? "");
  if (
    args.length !== 5 ||
    !CASE_NAME.test(caseName ?? "") ||
    !repoName ||
    !tierOk ||
    !lengthOk ||
    !task
  )
    throw new Error(USAGE);
  return {
    caseName: caseName!,
    repoName,
    tier: tier as PrivacyTier,
    length: length as CaseLength,
    task,
  };
}

/** Records the session and writes its case; returns the case file's path. Writes nothing on any failure. */
export async function recordCase(options: RecordOptions): Promise<string> {
  const {
    caseName,
    repoName,
    tier,
    length,
    task,
    casesDir = EVAL_CASES_DIR,
    workParent = tmpdir(),
    env = process.env,
    home = homedir(),
    user = userInfo().username,
    // With no TMPDIR passed (`claudeEnvironment`), Claude Code's temp folder is /tmp.
    claudeTmp = `/tmp/claude-${process.getuid?.() ?? ""}`,
  } = options;
  if (!CASE_NAME.test(caseName))
    throw new Error(`case name "${caseName}" isn't kebab-case. ${USAGE}`);
  const repo = SEEDED_ORG.find((r) => r.name === repoName);
  if (!repo)
    throw new Error(
      `repo "${repoName}" isn't in the Seeded org: one of ${SEEDED_ORG.map((r) => r.name).join(", ")}`,
    );
  const caseFile = join(casesDir, `${caseName}.json`);
  if (existsSync(caseFile)) throw new Error(`case "${caseName}" is already there: ${caseFile}`);
  const claude = onPath("claude", env.PATH);
  if (!claude)
    throw new Error("`claude` isn't on PATH: install Claude Code and sign in, then run this again");
  if ([user, basename(home)].some(isGenericName))
    throw new Error(
      `the user "${user}" with home ${home} is generic, so the case couldn't be told apart from it: record as your own user`,
    );

  const workRoot = mkdtempSync(join(workParent, "warden-eval-"));
  try {
    const projectDir = join(workRoot, "project");
    const captureDir = join(workRoot, "capture");
    for (const file of repo.files) {
      if (!("text" in file)) continue;
      mkdirSync(dirname(join(projectDir, file.path)), { recursive: true });
      writeFileSync(join(projectDir, file.path), file.text);
    }
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(captureDir);
    const script = join(captureDir, "capture.mjs");
    const captureFile = join(captureDir, "capture.jsonl");
    const settingsFile = join(captureDir, "settings.json");
    writeFileSync(script, CAPTURE_SCRIPT);
    writeFileSync(captureFile, "");
    writeFileSync(
      settingsFile,
      JSON.stringify(captureSettings(tier, script, captureFile), null, 2),
    );

    const run = await runClaude(claude, projectDir, env, [
      "-p",
      task,
      "--model",
      "haiku",
      "--max-turns",
      String(TURN_CAPS[length]),
      "--output-format",
      "json",
      // dontAsk: a call that would need approval is denied unless a rule pre-approves it (there's nobody to ask in
      // print mode).
      "--permission-mode",
      "dontAsk",
      // The user's own settings load, not the repo's: its .claude/settings*.json and .mcp.json are Seeded org
      // misconfigurations (hooks, permission rules, MCP servers) the session must not load. The user's settings carry
      // the sign-in and any proxy the session goes through, so they stay; but their hooks, mods and permission rules
      // load too, and can approve a call `ALLOWED_TOOLS` and dontAsk alone would deny.
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--settings",
      settingsFile,
      "--allowedTools",
      ...ALLOWED_TOOLS,
    ]);
    // A session cut by its turn cap is kept: it still ends with SessionEnd (#512).
    if (run.code !== 0 && run.subtype !== "error_max_turns")
      throw new Error(
        `claude exited with code ${run.code}, so no case was written: ${run.stderr.trim().slice(-400) || run.stdout.trim().slice(-400)}`,
      );

    const captured = readFileSync(captureFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const end = captured.findIndex((body) => body.hook_event_name === "SessionEnd");
    if (end === -1)
      throw new Error("no SessionEnd was captured from the session, so no case was written");
    const sessionIds = [
      ...new Set(captured.map((body) => body.session_id).filter((id) => typeof id === "string")),
    ];
    const events = captured.slice(0, end + 1).map((body) => {
      const withoutSession = { ...body };
      delete withoutSession.session_id;
      return withoutSession;
    });

    const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const rewrite = rewriter({
      workRoot,
      projectDir,
      configDir,
      home,
      user,
      claudeTmp,
      sessionIds,
    });
    const recorded = {
      name: caseName,
      description: task,
      group: "ordinary",
      split: null,
      tier,
      labels: [],
      stands_for: null,
      source: "recorded",
      length,
      events: events.map(rewrite),
    };
    const text = `${JSON.stringify(recorded, null, 2)}\n`;
    const leak = caseLeak(text, {
      folders: [workRoot, configDir, home, claudeTmp],
      sessionIds,
      user,
    });
    if (leak) throw new Error(`the recorded session still holds ${leak}, so no case was written`);
    writeFileSync(caseFile, text, { flag: "wx" });
    return caseFile;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** The command on PATH, or null. */
function onPath(command: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this folder
    }
  }
  return null;
}

/** The environment `claude` runs with: `PASSED_VARIABLES` from `env` where set, in the C locale. */
function claudeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const passed = PASSED_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(passed), LANG: "C", LC_ALL: "C" };
}

/** The managed-settings block's events and matchers for the tier, each hook a command that runs the capture script;
 * and the file tools, with the read-only commands Claude Code runs without a rule, kept to the project's folder. */
function captureSettings(tier: PrivacyTier, script: string, captureFile: string) {
  const block = managedSettings({ url: "http://localhost/", token: null, tier });
  const command = [process.execPath, script, captureFile].map(shellQuote).join(" ");
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    hooks: Object.fromEntries(
      Object.entries(block.hooks).map(([event, groups]) => [
        event,
        groups!.map((group) => ({
          ...group,
          hooks: [{ type: "command", command, timeout: 10 }],
        })),
      ]),
    ),
  };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Runs `claude` in the project to the end, with only `claudeEnvironment`'s variables; answers its exit code, its
 * output and the result's subtype when it printed one. */
async function runClaude(claude: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  const run = await runCommand([claude, ...args], claudeEnvironment(env), { cwd, clean: true });
  let subtype: string | undefined;
  try {
    subtype = (JSON.parse(run.stdout.trim()) as { subtype?: string }).subtype;
  } catch {
    // not the JSON result: a crash, or an older claude
  }
  return { ...run, subtype };
}

/** A folder's spellings: as given and its real path. */
function spellings(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // a home folder that isn't on this machine, in a test
  }
  return [...new Set([path, real])];
}
/** Claude Code's slug of a folder: its projects folder name. */
const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `user` as a whole word, case-sensitive, anywhere: in a path, or in a tool's output such as `whoami`, `ls -l` or
 * `git log`. A longer word holding it (alicesmith) doesn't match. Safe because the recorder refuses generic names. */
export const userWord = (user: string, flags = "") =>
  new RegExp(`(?<![A-Za-z0-9_])${escaped(user)}(?![A-Za-z0-9_])`, flags);

/** Every secret-fixtures.ts string export and its name, longest first, so a secret inside another is found second. */
const fixtureSecrets = () => [...FIXTURE_SECRETS].sort(([, a], [, b]) => b.length - a.length);

/** Rewrites every string and key of a hook body: the throwaway folder, Claude's config folder and scratchpad root,
 * home and the recorded session id to a developer `dev`'s, the user's name as a whole word to `dev`, and
 * each secret-fixtures.ts export to its `{{EXPORT}}` placeholder. */
function rewriter({
  workRoot,
  projectDir,
  configDir,
  home,
  user,
  claudeTmp,
  sessionIds,
}: {
  workRoot: string;
  projectDir: string;
  configDir: string;
  home: string;
  user: string;
  claudeTmp: string;
  sessionIds: readonly string[];
}) {
  const pairs: [string, string][] = [];
  const folder = (path: string, to: string) => {
    for (const spelling of spellings(path)) pairs.push([spelling, to], [slug(spelling), slug(to)]);
  };
  folder(projectDir, DEV_PROJECT);
  folder(workRoot, `${DEV_HOME}/eval`);
  folder(configDir, `${DEV_HOME}/.claude`);
  folder(claudeTmp, DEV_CLAUDE_TMP);
  folder(home, DEV_HOME);
  for (const id of sessionIds) pairs.push([id, DEV_SESSION_ID]);
  for (const [name, secret] of fixtureSecrets()) pairs.push([secret, `{{${name}}}`]);
  pairs.sort(([a], [b]) => b.length - a.length);
  const userName = userWord(user, "g");
  const fix = (text: string) => {
    for (const [from, to] of pairs) text = text.split(from).join(to);
    return text.replace(userName, DEV_USER);
  };
  return (body: Record<string, unknown>) => mapStrings(body, fix) as Record<string, unknown>;
}

/** What of the recording machine, or what secret, a case's text still holds, or null: a secret-fixtures.ts export, a
 * spelling of one of `folders` (or its slug), a recorded session id, the user's name as a whole word, or a secret
 * Guard's own patterns find. */
export function caseLeak(
  text: string,
  {
    folders,
    sessionIds,
    user,
  }: { folders: readonly string[]; sessionIds: readonly string[]; user: string },
): string | null {
  for (const [name, secret] of fixtureSecrets())
    if (text.includes(secret)) return `the secret-fixtures.ts export ${name}`;
  for (const path of folders.flatMap(spellings))
    for (const spelling of [path, slug(path)])
      if (text.includes(spelling)) return `the path ${spelling}`;
  for (const id of sessionIds) if (text.includes(id)) return `the recorded session id ${id}`;
  if (user && userWord(user).test(text)) return `the user name ${user}`;
  const [secret] = findSecrets("case", text);
  if (secret) return `a ${secret.type} on line ${secret.line}`;
  return null;
}

async function main() {
  try {
    const file = await recordCase(parseRecordArgs(process.argv.slice(2)));
    console.log(`Wrote ${file}. Set its split and stands_for, then run pnpm format.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
