// Records one ordinary eval case (#512): `pnpm --filter @warden/server eval:record -- <case-name> <repo-name> <tier>
// <length> "<task>"`. It writes a Seeded org repo's files to a throwaway folder, runs a real `claude -p` session there
// on the Claude subscription, catches each hook body Claude Code sends through command hooks, and writes the bodies
// as a case in the eval folder: labelled clean, with its split and stands_for left for the author to set.
//
// Claude Code's flags and hooks: https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/hooks
// and https://code.claude.com/docs/en/headless. The session runs in the dontAsk permission mode with a fixed tool
// list (https://code.claude.com/docs/en/permission-modes), never a permission-skip flag or mode.
import { spawn } from "node:child_process";
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
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivacyTier } from "@warden/contracts";
import { managedSettings } from "../../src/modules/guard/managed-settings.ts";
import { PLANTED_SECRETS, SEEDED_ORG } from "../seeded-org.ts";
import {
  CASE_LENGTHS,
  EVAL_CASES_DIR,
  FIXTURE_SECRETS,
  TURN_CAPS,
  type CaseLength,
} from "./eval-cases.ts";

const USAGE =
  'usage: pnpm --filter @warden/server eval:record -- <case-name> <repo-name> <metadata|details|content> <short|medium|long> "<task>"';

/** The tools the session may use without asking: reading and editing the project, and a few read-only or
 * project-local commands. In print mode anything else is refused, so the session can't reach past them. */
export const ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(wc *)",
  "Bash(node *)",
  "Bash(npm test)",
  "Bash(npm run *)",
];

/** Where the session seems to run, in the case: a developer `dev` with the project in their home folder. */
const DEV_HOME = "/home/dev";
const DEV_PROJECT = `${DEV_HOME}/project`;
const DEV_USER = "dev";

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
  /** The environment `claude` runs with, and whose PATH it's found on. */
  env?: NodeJS.ProcessEnv;
  /** The recording machine's home folder and user name, rewritten out of the case. */
  home?: string;
  user?: string;
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
      // dontAsk: tools off the list are denied, not asked about (there's nobody to ask in print mode).
      "--permission-mode",
      "dontAsk",
      // The user's own settings only: the repo's .claude/settings*.json and .mcp.json are Seeded org
      // misconfigurations (hooks, permission rules, MCP servers) the session must not load.
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
    const events = captured.slice(0, end + 1).map((body) => {
      const withoutSession = { ...body };
      delete withoutSession.session_id;
      return withoutSession;
    });

    const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const rewrite = rewriter({ workRoot, projectDir, configDir, home, user });
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
    const leak = leaks(text, [workRoot, configDir, home]);
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

/** The managed-settings block's events and matchers for the tier, each hook a command that runs the capture script. */
function captureSettings(tier: PrivacyTier, script: string, captureFile: string) {
  const block = managedSettings({ url: "http://localhost/", token: null, tier });
  const command = [process.execPath, script, captureFile].map(shellQuote).join(" ");
  return {
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

function runClaude(claude: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  const child = spawn(claude, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string; subtype?: string }>(
    (resolve, reject) => {
      child.on("error", (error) => reject(new Error("couldn't run `claude`", { cause: error })));
      child.on("close", (code) => {
        let subtype: string | undefined;
        try {
          subtype = (JSON.parse(stdout.trim()) as { subtype?: string }).subtype;
        } catch {
          // not the JSON result: a crash, or an older claude
        }
        resolve({ code, stdout, stderr, subtype });
      });
    },
  );
}

/** A folder's spellings: as given, its real path, and Claude Code's slug of each (its projects folder name). */
function spellings(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // a home folder that isn't on this machine, in a test
  }
  return [...new Set([path, real])];
}
const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

/** Rewrites every string and key of a hook body: the throwaway folder, Claude's config folder, home and user to a
 * developer `dev`'s, and each planted secret to its `{{EXPORT}}` placeholder from secret-fixtures.ts. */
function rewriter({
  workRoot,
  projectDir,
  configDir,
  home,
  user,
}: {
  workRoot: string;
  projectDir: string;
  configDir: string;
  home: string;
  user: string;
}) {
  const pairs: [string, string][] = [];
  const folder = (path: string, to: string) => {
    for (const spelling of spellings(path)) pairs.push([spelling, to], [slug(spelling), slug(to)]);
  };
  folder(projectDir, DEV_PROJECT);
  folder(workRoot, `${DEV_HOME}/eval`);
  folder(configDir, `${DEV_HOME}/.claude`);
  folder(home, DEV_HOME);
  for (const [name, secret] of FIXTURE_SECRETS)
    if (PLANTED_SECRETS.includes(secret)) pairs.push([secret, `{{${name}}}`]);
  pairs.sort(([a], [b]) => b.length - a.length);
  const userWord = new RegExp(
    `(?<![A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
    "gi",
  );
  const fix = (text: string) => {
    for (const [from, to] of pairs) text = text.split(from).join(to);
    return user ? text.replace(userWord, DEV_USER) : text;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return fix(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [fix(key), walk(inner)]),
      );
    return value;
  };
  return (body: Record<string, unknown>) => walk(body) as Record<string, unknown>;
}

/** What of the recording machine the case text still holds, or null. */
function leaks(text: string, folders: readonly string[]): string | null {
  for (const path of folders.flatMap(spellings)) if (text.includes(path)) return `the path ${path}`;
  if (PLANTED_SECRETS.some((secret) => text.includes(secret))) return "a planted secret";
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
