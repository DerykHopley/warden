// Guard's agent-config Rules (Guard spec, story 3): what a repo's Claude Code config lets the agent do. Slice 4a holds
// the two per-file Rules: a broad Bash allow in a settings file, and the flag or mode that skips permission checks.
// A settings file is read as Claude Code reads it, through its own keys (`permissions.allow`, `permissions.defaultMode`);
// a file that isn't valid JSON holds no rules, as Claude Code wouldn't apply it either. A summary quotes only allow
// entries that match the broad patterns, which can't hold a secret, and never a line of a file. The flag and the mode
// are built here by joining their parts, so this file never holds a whole one for a Guard Scan of Warden to report.
import type { Asset, Observation, RuleId } from "@warden/contracts";
import { BLANKET_BASH_ALLOW, packRule, PERMISSION_SKIP } from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";

/** A repo's agent-config check, made once per repo: `see` takes each of its files in turn. */
export interface AgentConfigCheck {
  /** The per-file Rules' Observations for one file: at most one per Rule. */
  see(file: RepoFile): Observation[];
}

export function agentConfigCheck(asset: Asset): AgentConfigCheck {
  return {
    see(file) {
      const settings = isClaudeSettingsFile(file.path) ? readClaudeSettings(file.text) : undefined;
      return [
        blanketBashAllow(asset, file.path, settings),
        permissionSkip(asset, file, settings),
      ].filter((observation) => observation !== undefined);
    },
  };
}

/** A Claude Code settings file: `.claude/settings.json` or `.claude/settings.local.json` in any folder. */
function isClaudeSettingsFile(path: string): boolean {
  return /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path);
}

/** What the agent-config Rules read from a settings file, each value with the line it starts on. */
type ClaudeSettings = {
  /** `permissions.allow`'s string entries, in order. */
  allow: readonly { rule: string; line: number }[];
  /** `permissions.defaultMode`, when it is a string. */
  defaultMode: { mode: string; line: number } | undefined;
};

const NO_SETTINGS: ClaudeSettings = { allow: [], defaultMode: undefined };

/** A settings file's permissions. A file that isn't valid JSON, and a field of another type, hold nothing. */
function readClaudeSettings(text: string): ClaudeSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NO_SETTINGS;
  }
  const permissions = isObject(parsed) ? parsed.permissions : undefined;
  if (!isObject(permissions)) return NO_SETTINGS;
  const lines = valueLines(text, 3);
  const lineOf = (...path: (string | number)[]) => lines.get(JSON.stringify(path)) ?? 1;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const mode = permissions.defaultMode;
  return {
    allow: allow.flatMap((rule, i) =>
      typeof rule === "string" ? [{ rule, line: lineOf("permissions", "allow", i) }] : [],
    ),
    defaultMode:
      typeof mode === "string" ? { mode, line: lineOf("permissions", "defaultMode") } : undefined,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The line (from 1) each value at most `depth` levels deep starts on, keyed by its path as JSON (`["permissions",
 * "allow",0]`). Reads text `JSON.parse` has already accepted. A key repeated in an object answers its last value's
 * line, as `JSON.parse` keeps the last value. Deeper values are stepped over without recursion, so a deeply nested
 * file can't overflow the stack.
 */
function valueLines(text: string, depth: number): Map<string, number> {
  const lines = new Map<string, number>();
  let i = 0;
  let line = 1;
  const skipBlank = () => {
    while (i < text.length && /[ \t\n\r]/.test(text[i]!)) {
      if (text[i] === "\n") line += 1;
      i += 1;
    }
  };
  // JSON strings hold no raw line break, so stepping over one never passes a line.
  const readString = (): string => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const skipValue = () => {
    let open = 0;
    do {
      const c = text[i]!;
      if (c === '"') {
        readString();
        continue;
      }
      if (c === "\n") line += 1;
      if (c === "{" || c === "[") open += 1;
      if (c === "}" || c === "]") open -= 1;
      i += 1;
    } while (open > 0 && i < text.length);
  };
  const value = (path: (string | number)[]) => {
    skipBlank();
    lines.set(JSON.stringify(path), line);
    const c = text[i];
    if (path.length >= depth && (c === "{" || c === "[")) return skipValue();
    if (c === "{") {
      i += 1;
      skipBlank();
      if (text[i] === "}") return void (i += 1);
      for (;;) {
        skipBlank();
        const key = readString();
        skipBlank();
        i += 1; // the `:`
        value([...path, key]);
        skipBlank();
        if (text[i++] === "}") return;
      }
    }
    if (c === "[") {
      i += 1;
      skipBlank();
      if (text[i] === "]") return void (i += 1);
      for (let n = 0; ; n += 1) {
        value([...path, n]);
        skipBlank();
        if (text[i++] === "]") return;
      }
    }
    if (c === '"') return void readString();
    while (i < text.length && !/[ \t\n\r,\]}]/.test(text[i]!)) i += 1;
  };
  value([]);
  return lines;
}

/** Shells and interpreters: `-c` runs whatever command text follows. */
const RUNS_CODE = ["sh", "bash", "zsh", "python", "python3"];

/** Commands that read files or run a shell: a wildcard allow for one lets the agent read or run anything. */
const READS_OR_RUNS = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "awk",
  "sed",
  "find",
  "xargs",
  "cp",
  "env",
  "printenv",
  "eval",
  "node",
  "perl",
  "ruby",
  ...RUNS_CODE,
];

/** A command given by path (`/bin/`, `/usr/local/bin/`, `./bin/`, `~/bin/`): path words only, never a space. */
const BY_PATH = String.raw`(?:(?:~|\.{1,2})?(?:/[\w.-]+)*/)?`;

/** A listed command, maybe by path; a shell or interpreter maybe with `-c`. */
const COMMAND = `${BY_PATH}(?:(?:${RUNS_CODE.join("|")}) -c|${READS_OR_RUNS.join("|")})`;

/**
 * A broad Bash allow: the whole tool (`Bash`, `Bash(*)`, `Bash(:*)`, `Bash(**)`), or a wildcard for a command that
 * reads files or runs a shell, in any of Claude Code's three trailing forms (`Bash(cat:*)`, `Bash(cat *)`,
 * `Bash(cat*)`). The command may be given by path (`Bash(/bin/cat:*)`), and a shell or interpreter may come with
 * `-c` (`Bash(bash -c:*)`).
 */
const BROAD_BASH = new RegExp(String.raw`^Bash(?:\((?:\*|:\*|\*\*|${COMMAND}(?::\*| \*|\*))\))?$`);

/** How many broad allows a summary names before "and N more". */
const NAMED = 3;

function blanketBashAllow(
  asset: Asset,
  path: string,
  settings: ClaudeSettings | undefined,
): Observation | undefined {
  const broad = (settings?.allow ?? []).filter(({ rule }) => BROAD_BASH.test(rule));
  const [first] = broad;
  if (first === undefined) return undefined;
  const count = broad.length;
  const named = broad.slice(0, NAMED).map(({ rule }) => rule);
  const more = count > NAMED ? ` and ${count - NAMED} more` : "";
  const allows = count === 1 ? "allow" : "allows";
  return observation(
    asset,
    BLANKET_BASH_ALLOW,
    path,
    first.line,
    `${count} broad Bash ${allows} (${named.join(", ")}${more}) in ${path}, ${where(count, first.line)}`,
  );
}

const SKIP_WORDS = ["dangerously", "skip", "permissions"].join("-");
const MODE_FLAG = ["--permission", "mode"].join("-");
const BYPASS = ["bypass", "Permissions"].join("");

/**
 * The flags and options that start the agent with its permission checks off, each named by its kind. Each match may
 * run over lines (an argv array, a backslash continuation); it counts on the line it starts on.
 */
const SKIP_FLAGS: readonly { kind: string; pattern: RegExp }[] = [
  // No leading `--`, so a longer flag built on the same words counts too.
  { kind: `--${SKIP_WORDS}`, pattern: new RegExp(SKIP_WORDS, "g") },
  {
    // `--permission-mode` then its value: after a space, `=`, a quote, an argv array's `","`, or a line continuation.
    kind: `${MODE_FLAG} ${BYPASS}`,
    pattern: new RegExp(String.raw`${MODE_FLAG}["']?(?:[\s,=]|\\(?=\r?\n))+["']?${BYPASS}\b`, "g"),
  },
  {
    // The Agent SDK's option: `permissionMode` (TypeScript, JSON) or `permission_mode` (Python).
    kind: `permissionMode ${BYPASS}`,
    pattern: new RegExp(
      String.raw`\bpermission(?:Mode|_mode)["']?[ \t]*[:=][ \t]*["']?${BYPASS}\b`,
      "g",
    ),
  },
];

/** Docs describe the flag; scripts, CI and config run it. */
const DOCS_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|html)$/i;

/** A shell or YAML comment line, which only mentions the flag. A `#!` line runs it, so isn't one. */
const COMMENT_LINE = /^[ \t]*#(?!!)/;

type Place = { kind: string; line: number };

function permissionSkip(
  asset: Asset,
  { path, text }: RepoFile,
  settings: ClaudeSettings | undefined,
): Observation | undefined {
  // A settings file counts only through its parsed `defaultMode`: its text can name the flag to deny or block it.
  const places =
    settings !== undefined
      ? defaultModePlaces(settings)
      : DOCS_FILE.test(path)
        ? []
        : flagPlaces(text);
  if (places.length === 0) return undefined;
  places.sort((a, b) => a.line - b.line);
  const first = places[0]!.line;
  const count = places.length;
  const kinds = [...new Set(places.map((place) => place.kind))].join(", ");
  const verb = count === 1 ? "place skips" : "places skip";
  return observation(
    asset,
    PERMISSION_SKIP,
    path,
    first,
    `${count} ${verb} the agent's permission checks (${kinds}) in ${path}, ${where(count, first)}`,
  );
}

/** Claude Code ignores `defaultMode` bypass in project and local settings from v2.1.257; older versions apply it. */
const defaultModePlaces = ({ defaultMode }: ClaudeSettings): Place[] =>
  defaultMode?.mode === BYPASS
    ? [
        {
          kind: `defaultMode ${BYPASS} (applies before Claude Code v2.1.257)`,
          line: defaultMode.line,
        },
      ]
    : [];

function flagPlaces(text: string): Place[] {
  const lines = text.split("\n");
  // Where each line starts in `text`, to find the line a match starts on.
  const starts: number[] = [];
  lines.reduce((start, content) => (starts.push(start), start + content.length + 1), 0);
  const lineAt = (index: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (starts[mid]! <= index) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return SKIP_FLAGS.flatMap(({ kind, pattern }) =>
    Array.from(text.matchAll(pattern), (match) => lineAt(match.index))
      .filter((line) => !COMMENT_LINE.test(lines[line - 1]!))
      .map((line) => ({ kind, line })),
  );
}

const where = (count: number, line: number) =>
  count === 1 ? `on line ${line}` : `first on line ${line}`;

/** One Observation under a Pack Rule, its summary ending with the Rule's fix. */
function observation(
  asset: Asset,
  ruleId: RuleId,
  path: string,
  line: number,
  summary: string,
): Observation {
  const rule = packRule(ruleId);
  return {
    asset,
    rule_id: rule.ruleId,
    location: { kind: "file", path, line },
    severity: rule.severity,
    title: rule.title,
    evidence: { summary: `${summary}. To fix: ${rule.fix}` },
  };
}
