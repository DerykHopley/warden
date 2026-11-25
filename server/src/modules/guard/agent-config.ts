// Guard's agent-config Rules (Guard spec, story 3): what a repo's Claude Code config lets the agent do. Two are per
// file: a broad Bash allow in a settings file, and the flag or mode that skips permission checks. Two are whole-repo,
// answered once every file has been seen: the agent can read .env, and nothing checks the agent's tool calls.
// A settings file is read as Claude Code reads it, through its own keys (`permissions.allow`, `permissions.deny`,
// `permissions.defaultMode`, `hooks`); a file that isn't valid JSON holds no rules, as Claude Code wouldn't apply it
// either. A summary quotes only allow entries that match the broad patterns, which can't hold a secret, and never a
// line of a file. The flag and the mode are built here by joining their parts, so this file never holds a whole one
// for a Guard Scan of Warden to report.
import type { Asset, Observation, RuleId } from "@warden/contracts";
import {
  AGENT_CAN_READ_ENV,
  BLANKET_BASH_ALLOW,
  NO_RUNTIME_GUARD,
  packRule,
  PERMISSION_SKIP,
} from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";

/**
 * A repo's agent-config check, made once per repo: `see` takes each of its files in turn, `unread` each file the
 * reader couldn't read, and `end` answers the whole-repo Rules once all of them have been through.
 */
export interface AgentConfigCheck {
  /** The per-file Rules' Observations for one file: at most one per Rule. */
  see(file: RepoFile): Observation[];
  /** Notes a file the reader couldn't read: its path still shows whether the repo uses Claude Code. */
  unread(path: string): void;
  /**
   * The whole-repo Rules' Observations, at most one per Rule; none for a repo that doesn't use Claude Code. Undefined
   * when a root settings file was unread, as what the repo's agent config holds is then unknown.
   */
  end(): Observation[] | undefined;
}

/** The root settings files, which Claude Code merges into the repo's agent config. */
/** Where each whole-repo Observation sits, with no line: the root settings file a fix goes in. */
export const WHOLE_REPO_PATH = ".claude/settings.json";
const ROOT_SETTINGS = [WHOLE_REPO_PATH, ".claude/settings.local.json"];
const ROOT_CONFIG = ROOT_SETTINGS.join(" or ");

export function agentConfigCheck(asset: Asset): AgentConfigCheck {
  let usesClaudeCode = false;
  let rootUnread = false;
  const root: ClaudeSettings[] = [];
  return {
    see(file) {
      usesClaudeCode ||= isClaudeCodePath(file.path);
      const settings = isClaudeSettingsFile(file.path) ? readClaudeSettings(file.text) : undefined;
      if (settings !== undefined && ROOT_SETTINGS.includes(file.path)) root.push(settings);
      return [
        blanketBashAllow(asset, file.path, settings),
        permissionSkip(asset, file, settings),
      ].filter((observation) => observation !== undefined);
    },
    unread(path) {
      usesClaudeCode ||= isClaudeCodePath(path);
      rootUnread ||= ROOT_SETTINGS.includes(path);
    },
    end() {
      if (rootUnread) return undefined;
      if (!usesClaudeCode) return [];
      const deny = root.flatMap((settings) => settings.deny);
      const hooks = root.flatMap((settings) => settings.hooks);
      return [agentCanReadEnv(asset, deny), noRuntimeGuard(asset, deny, hooks)].filter(
        (observation) => observation !== undefined,
      );
    },
  };
}

/** A sign the repo uses Claude Code: a `.claude` folder, or a `CLAUDE.md` or `.mcp.json`, in any folder. */
function isClaudeCodePath(path: string): boolean {
  return /(?:^|\/)(?:\.claude\/|(?:CLAUDE\.md|\.mcp\.json)$)/.test(path);
}

/** A Claude Code settings file: `.claude/settings.json` or `.claude/settings.local.json` in any folder. */
function isClaudeSettingsFile(path: string): boolean {
  return /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path);
}

type PermissionEntry = { rule: string; line: number };

/** A hook that runs a command: its event (`PreToolUse`, `Stop`, …), and the `command` value with its line. */
type HookCommand = { event: string; command: string; line: number };

/** What the agent-config Rules read from a settings file, each value with the line it starts on. */
type ClaudeSettings = {
  /** `permissions.allow`'s string entries, in order. */
  allow: readonly PermissionEntry[];
  /** `permissions.deny`'s string entries, in order. */
  deny: readonly PermissionEntry[];
  /** `permissions.defaultMode`, when it is a string. */
  defaultMode: { mode: string; line: number } | undefined;
  /** Every `type: "command"` hook with a string `command`, under any event. */
  hooks: readonly HookCommand[];
};

const NO_SETTINGS: ClaudeSettings = { allow: [], deny: [], defaultMode: undefined, hooks: [] };

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** How deep `valueLines` reads: down to a hook's `command`, at `hooks.<event>.<group>.hooks.<hook>.command`. */
const SETTINGS_DEPTH = 6;

/**
 * A settings file's permissions and hook commands. Text that starts with a byte order mark is read without it. A file
 * that still isn't valid JSON, and a field of another type, hold nothing.
 */
function readClaudeSettings(raw: string): ClaudeSettings {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NO_SETTINGS;
  }
  if (!isObject(parsed)) return NO_SETTINGS;
  const lines = valueLines(text, SETTINGS_DEPTH);
  const lineOf = (...path: (string | number)[]) => lines.get(JSON.stringify(path)) ?? 1;
  const permissions = isObject(parsed.permissions) ? parsed.permissions : {};
  const entries = (key: "allow" | "deny"): PermissionEntry[] =>
    asArray(permissions[key]).flatMap((rule, i) =>
      typeof rule === "string" ? [{ rule, line: lineOf("permissions", key, i) }] : [],
    );
  const mode = permissions.defaultMode;
  return {
    allow: entries("allow"),
    deny: entries("deny"),
    defaultMode:
      typeof mode === "string" ? { mode, line: lineOf("permissions", "defaultMode") } : undefined,
    hooks: Object.entries(isObject(parsed.hooks) ? parsed.hooks : {}).flatMap(([event, groups]) =>
      asArray(groups).flatMap((group, g) =>
        asArray(isObject(group) ? group.hooks : undefined).flatMap((hook, h) =>
          isObject(hook) && hook.type === "command" && typeof hook.command === "string"
            ? [
                {
                  event,
                  command: hook.command,
                  line: lineOf("hooks", event, g, "hooks", h, "command"),
                },
              ]
            : [],
        ),
      ),
    ),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

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
  // A settings file counts only through its parsed `defaultMode` and the hooks that run the agent: its text can name
  // the flag to deny or block it.
  const places =
    settings !== undefined
      ? [...defaultModePlaces(settings), ...hookPlaces(settings)]
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

/** Where a word stands in its command. */
type Position = {
  /** It may be the command word. */
  command: boolean;
  /** An assignment or a redirect came first in its command, so no word of it is a reserved word. */
  prefixed: boolean;
  /** It comes after a wrapper's command word. */
  wrapped: boolean;
  /** It is a word to skip: a redirect's target, a function's name, the value of an option of the `time` program. */
  target: boolean;
  /** The options the reserved word `time` before it may still take, in order. */
  timeOptions: readonly string[];
  /** It may be an option of the `time` program before it, rather than that program's command word. */
  timeProgram: boolean;
  /** It is the first word after the reserved word `coproc`. */
  coproc: boolean;
  /**
   * It follows the first word after `coproc`, which is the coprocess's name when this word starts a compound command,
   * and otherwise was the command word: `ifCommand` is where this word then stands, and `start` where that word's run
   * of the agent starts, if it ran it.
   */
  named: { ifCommand: Position; start: number | undefined } | undefined;
};

/** The first word of a command, as after `;`, `&&`, `|`, a newline, `(` or an opening backquote. */
const COMMAND_START: Position = {
  command: true,
  prefixed: false,
  wrapped: false,
  target: false,
  timeOptions: [],
  timeProgram: false,
  coproc: false,
  named: undefined,
};

/** Any word after the command word, when that command isn't a wrapper. */
const AFTER_COMMAND: Position = { ...COMMAND_START, command: false };

/** The characters that end a word, unless a backslash escapes them or (an `&` or `|`) a redirect holds them. */
const ENDS_WORD = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "`"]);

/** The ends of a word that also end its command, so the next word is a command word. */
const STARTS_COMMAND = new Set(["\n", ";", "&", "|"]);

/**
 * The reserved word `time`, as the first word of a command; after an assignment or a redirect, or by path
 * (`/usr/bin/time`), the word runs the `time` program instead.
 */
const TIME = "time";

/** Words that keep the next word a command word, when they are themselves reserved words. */
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", TIME]);

/** The options the reserved word `time` takes before its command word, as bash reads them: one `-p`, then one `--`. */
const TIME_OPTIONS = ["-p", "--"];

/**
 * An option of the `time` program that takes the next word as its value: `-f`, `-o`, `--format` or `--output`, or a
 * cluster of short options whose first `f` or `o` is its last letter (`-ao`).
 */
const TIME_PROGRAM_VALUE = /^(?:-[^-fo]*[fo]|--(?:format|output))$/;

/** A reserved word whose next word is a name, with a command after it: `function f { claude …; }`. */
const NAMES_NEXT = "function";

/** The reserved word that runs a command as a coprocess, maybe named: `coproc NAME { claude …; }`. */
const COPROC = "coproc";

/** The words that start a compound command, which `coproc` runs as it is anywhere (a `(` does too). */
const COMPOUND_STARTS = new Set(["{", "if", "while", "until", "for", "select", "case", "[["]);

/** The end of a word that a `(` after it continues, as a command or process substitution: `x=$(…)bar`, `<(…)`. */
const SUBSTITUTES = /[$<>]$/;

/** Commands that run a later word of theirs as a command, past any options and values between. */
const WRAPPERS = new Set([
  "env",
  "exec",
  "command",
  "nohup",
  "nice",
  "timeout",
  "sudo",
  "xargs",
  "npx",
  "bunx",
  "pnpm",
  "yarn",
]);

/** `NAME=value` (or `NAME+=value`) before the command word. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

/** A redirect before the command word, with its target (`>out`, `2>/dev/null`) or without it (`>`, `2>>`). */
const REDIRECT = /^\d*(?:[<>]|&>)/;
const REDIRECT_ALONE = /^\d*(?:[<>]{1,2}|&>>?|[<>]&|>\|)$/;

/** A word's last `/`-segment: the command `/usr/bin/claude` or `@anthropic-ai/claude-code` runs. */
const commandName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** Whether a word, its backslashes removed, runs the agent: `claude`, or `claude-code` as `npx` runs it. */
const isAgent = (word: string) => /^claude(?:-code)?$/.test(commandName(word));

/**
 * Where a run of the agent starts if `word`, which ends at `end`, starts one from `at` (at `end`, or at the end of the
 * word after `coproc` when this word shows that one was the command word), and where the word after it stands.
 */
function readWord(
  at: Position,
  word: string,
  end: number,
): [start: number | undefined, next: Position] {
  if (at.target) return [undefined, { ...at, target: false }];
  if (at.named !== undefined) {
    if (COMPOUND_STARTS.has(word)) return readWord(COMMAND_START, word, end);
    const [start, next] = readWord(at.named.ifCommand, word, end);
    return [at.named.start ?? start, next];
  }
  if (!at.command) return at.wrapped && isAgent(word) ? [end, AFTER_COMMAND] : [undefined, at];
  if (at.coproc) {
    if (COMPOUND_STARTS.has(word)) return readWord(COMMAND_START, word, end);
    // Bash reads no reserved word here but a compound command's: `coproc ! claude` runs a command named `!`.
    const [start, next] = readWord({ ...at, coproc: false, prefixed: true }, word, end);
    if (ASSIGNMENT.test(word) || REDIRECT.test(word)) return [start, next];
    return [undefined, { ...AFTER_COMMAND, named: { ifCommand: next, start } }];
  }
  const option = at.timeOptions.indexOf(word);
  if (option >= 0) return [undefined, { ...at, timeOptions: at.timeOptions.slice(option + 1) }];
  if (at.timeProgram && word.startsWith("-")) {
    const value = TIME_PROGRAM_VALUE.test(word);
    return [undefined, { ...at, timeProgram: word !== "--", target: value }];
  }
  if (ASSIGNMENT.test(word)) return [undefined, { ...at, prefixed: true, timeOptions: [] }];
  if (REDIRECT.test(word)) {
    const alone = REDIRECT_ALONE.test(word);
    return [undefined, { ...at, prefixed: true, timeOptions: [], target: alone }];
  }
  if (!at.prefixed && RESERVED.has(word)) {
    return [undefined, { ...at, timeOptions: word === TIME ? TIME_OPTIONS : [] }];
  }
  if (!at.prefixed && word === NAMES_NEXT) {
    return [undefined, { ...at, timeOptions: [], target: true }];
  }
  if (!at.prefixed && word === COPROC) return [undefined, { ...COMMAND_START, coproc: true }];
  if (isAgent(word)) return [end, AFTER_COMMAND];
  if (commandName(word) === TIME) {
    return [undefined, { ...COMMAND_START, prefixed: true, timeProgram: true }];
  }
  return [undefined, { ...AFTER_COMMAND, wrapped: WRAPPERS.has(commandName(word)) }];
}

/**
 * Where each run of the agent's arguments starts, in a command with its quotes masked: just after each word that runs
 * it. Reads command words, not the whole shell grammar. A word ends at unescaped white space, `;`, `&`, `|`, `(`, `)`
 * or a backquote; a backslash joins the character it escapes to the word, and a line continuation joins the words
 * either side. A word runs the agent when it is the command word (the first of a command, past `NAME=value`, a
 * redirect and reserved words such as `then` or `!`, and `time`'s `-p` and `--`), the `time` program's command word
 * (past its options and their values), or any later word after a wrapper (`env`, `sudo`, `npx`, …). A word is a
 * reserved word only before any assignment or redirect in its command; after one, it is the command word, and `time`
 * is the `time` program, as it is by path (`/usr/bin/time`). After the reserved word `coproc`, a compound command is
 * read as it is anywhere; any other word is its command word, unless a compound command follows that word, which makes
 * it the coprocess's name. An unescaped `#` at a word's start hides the rest of its line. Each `(` and backquote
 * starts a command, and its close restores where the word before it stood; inside backquotes, an escaped
 * backquote opens or closes a nested one. A backquote, `$(`, `<(` or `>(` inside a word (`x=$(foo)bar`) doesn't end the
 * word: it goes on after the close. After a `)` that closes nothing (a `case` pattern's) or one whose `(` came after a
 * command's word (a `case` pattern's `(a)`, a function's `()`), a command starts; so it does after `function` and the
 * name that follows it.
 */
function agentRunStarts(masked: string): number[] {
  const starts: number[] = [];
  // What each open `(`, backquote (`` ` ``) or nested backquote (`` \` ``) interrupted: where the next word stands at
  // its close, and the word it is inside (`x=$`), which goes on after the close.
  const open: { by: string; after: Position; word: string | undefined }[] = [];
  const inBackquotes = () => open.some(({ by }) => by !== "(");
  let at = COMMAND_START;
  let word: string | undefined;
  const endWord = (index: number) => {
    if (word === undefined) return;
    const [start, next] = readWord(at, word, index);
    if (start !== undefined) starts.push(start);
    at = next;
    word = undefined;
  };
  const enter = (by: string, after: Position = at) => {
    open.push({ by, after, word });
    at = COMMAND_START;
    word = undefined;
  };
  const close = (index: number) => {
    const { by, after, word: outer } = open[index]!;
    at = after;
    word = outer === undefined ? undefined : outer + (by === "(" ? ")" : "`");
    open.length = index;
  };
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "\\") {
      const length = escapedLength(masked, index);
      const escaped = masked.slice(index + 1, index + 1 + length);
      index += length;
      if (escaped === "\n" || escaped === "\r\n" || escaped === "") continue;
      if (escaped !== "`" || !inBackquotes()) {
        word = (word ?? "") + escaped;
        continue;
      }
      endWord(index - 1);
      const nested = open.findLastIndex(({ by }) => by !== "(");
      if (open[nested]!.by === "\\`") close(nested);
      else enter("\\`");
    } else if (char === "#" && word === undefined) {
      // A comment, to the end of its line, or to the backquote that closes the command it is in.
      const ends = inBackquotes() ? /\n|`/g : /\n/g;
      ends.lastIndex = index;
      index = (ends.exec(masked)?.index ?? masked.length) - 1;
    } else if (!ENDS_WORD.has(char) || isRedirect(masked, index)) {
      word = (word ?? "") + char;
    } else if (
      (char === "`" && !inBackquotes()) ||
      (char === "(" && SUBSTITUTES.test(word ?? ""))
    ) {
      enter(char);
    } else {
      endWord(index);
      if (STARTS_COMMAND.has(char)) at = COMMAND_START;
      // A `(` after a command's word opens a `case` pattern (`(a)`) or a function's `()`: a command follows its close.
      else if (char === "(") enter("(", at.command ? at : COMMAND_START);
      else if (char === ")" && open.at(-1)?.by === "(") close(open.length - 1);
      // A `)` that closes nothing ends a `case` pattern (`a)`): a command follows.
      else if (char === ")") at = COMMAND_START;
      else if (char === "`") close(open.findIndex(({ by }) => by === "`"));
    }
  }
  endWord(masked.length);
  // A run after `coproc` is known only at the next word, after any run inside that word: `coproc claude $(claude …)`.
  return starts.sort((a, b) => a - b);
}

/**
 * The characters that end a command, unless a redirect, a group or backquotes holds them: those that start the next
 * one, and the `)` that closes the group or substitution the command is in.
 */
const ENDS_COMMAND = new Set([...STARTS_COMMAND, ")"]);

/**
 * Where a run's arguments end, from `start` in a command with its quotes masked: the index of the `;`, `&`, `|`,
 * newline or `)` that ends the command, or the command's length. A backslash and the character it escapes (a line
 * continuation among them) don't end it. Nor does a redirect's `&` (`>&`, `<&`, `&>`, `&>>`) or `|` (`>|`), though
 * `&&`, `|&` and a lone `&` or `|` do. Any `(` the run opens (`$(`, `<(`, `$((` or a bare one) and a backquote hold
 * everything up to their close, the close included; one that never closes runs to the end. A `)` the run didn't open
 * still ends it, as does a backquote it didn't open: the one that closes the backquotes the run started in.
 */
function runArgumentsEnd(masked: string, start: number): number {
  const startsInBackquotes = backquotesOpenAt(masked, start);
  let depth = 0;
  let inBackquotes = false;
  for (let index = start; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "\\") index += escapedLength(masked, index);
    else if (char === "`" && startsInBackquotes && depth === 0) return index;
    else if (char === "`") inBackquotes = !inBackquotes;
    else if (inBackquotes) continue;
    else if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (depth === 0 && ENDS_COMMAND.has(char) && !isRedirect(masked, index)) return index;
  }
  return masked.length;
}

/**
 * Whether `index` in a command with its quotes masked is inside backquotes: an odd number of backquotes before it,
 * skipping a backslash and the character it escapes. Backquotes escaped inside backquotes aren't nested spans here.
 */
function backquotesOpenAt(masked: string, index: number): boolean {
  let open = false;
  for (let at = 0; at < index; at++) {
    if (masked[at] === "\\") at += escapedLength(masked, at);
    else if (masked[at] === "`") open = !open;
  }
  return open;
}

/** How many characters the backslash at `index` escapes: two for a CRLF line continuation, otherwise one. */
function escapedLength(masked: string, index: number): number {
  return masked.startsWith("\r\n", index + 1) ? 2 : 1;
}

/** Whether the `&` or `|` at `index` belongs to a redirect: `>&`, `<&`, `&>` (`&>>` too) or `>|`. */
function isRedirect(masked: string, index: number): boolean {
  const before = masked[index - 1];
  if (masked[index] === "&") return before === ">" || before === "<" || masked[index + 1] === ">";
  return masked[index] === "|" && before === ">";
}

/**
 * A backslash and the character it escapes, or a single- or double-quoted argument (to the end of the text when it
 * isn't closed). In double quotes a backslash escapes the next character; in single quotes nothing is escaped.
 */
const ESCAPE_OR_QUOTED = /\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?/g;

/**
 * A shell command with each quoted argument, its quotes too, masked by `_`, so its length and every index stay the
 * same, except those `keep` leaves as written: text inside quotes is never a command word. `bash -c "claude …"` is
 * missed, as a guard hook that greps for the flag is the commoner case.
 */
const withQuotesMasked = (command: string, keep: (quoted: string) => boolean = () => false) =>
  command.replace(ESCAPE_OR_QUOTED, (match) =>
    match.startsWith("\\") || keep(match) ? match : "_".repeat(match.length),
  );

/** A quoted argument of one word, as the flag or the mode's value is; a prompt holds more. */
const isOneWord = (quoted: string) => !/\s/.test(quoted);

/**
 * Each run of the agent in a shell command, as its own arguments: the flag or mode value may be quoted, so a one-word
 * quoted argument stays as written. The next run is looked for after this one ends, so no text is in two.
 */
function agentRuns(command: string): string[] {
  const masked = withQuotesMasked(command);
  const runs: string[] = [];
  let end = 0;
  for (const start of agentRunStarts(masked)) {
    // A run inside an earlier run's arguments (`claude -p $(claude -p y)`) is part of that run.
    if (start < end) continue;
    end = runArgumentsEnd(masked, start);
    runs.push(withQuotesMasked(command.slice(start, end), isOneWord));
  }
  return runs;
}

/**
 * Each run of the agent in each hook command, once per flag in that run's own arguments, on the `command` value's
 * line. A later command, or a quoted argument of more than one word (a prompt), isn't one of them.
 */
const hookPlaces = ({ hooks }: ClaudeSettings): Place[] =>
  hooks.flatMap(({ command, line }) =>
    agentRuns(command).flatMap((args) =>
      SKIP_FLAGS.flatMap(({ kind, pattern }) =>
        Array.from(args.matchAll(pattern), () => ({ kind, line })),
      ),
    ),
  );

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

// A deny entry that stops a read of `.env`: the whole Read tool, or a Read pattern that ends in `.env` or `.env*`,
// after an optional `./`, `/`, `**/`, `./**/`, `/**/` or `//**/`. In project settings `/` is the project root, and
// `**` matches across folders, none included, so each reaches the root `.env`. `Read(./.env.*)` stops only
// `.env.local` and the like.
const DENIES_ENV = /^Read(?:\((?:\.\/|\/|\*\*\/|\.\/\*\*\/|\/\*\*\/|\/\/\*\*\/)?\.env\*?\))?$/;

function agentCanReadEnv(asset: Asset, deny: readonly PermissionEntry[]): Observation | undefined {
  if (deny.some(({ rule }) => DENIES_ENV.test(rule))) return undefined;
  return observation(
    asset,
    AGENT_CAN_READ_ENV,
    WHOLE_REPO_PATH,
    undefined,
    `No permissions.deny rule in ${ROOT_CONFIG} stops the agent reading .env`,
  );
}

/** Whether a guard is set up (a deny rule or a PreToolUse hook command), not whether it works. */
function noRuntimeGuard(
  asset: Asset,
  deny: readonly PermissionEntry[],
  hooks: readonly HookCommand[],
): Observation | undefined {
  if (deny.length > 0 || hooks.some(({ event }) => event === "PreToolUse")) return undefined;
  return observation(
    asset,
    NO_RUNTIME_GUARD,
    WHOLE_REPO_PATH,
    undefined,
    `Nothing checks the agent's tool calls: no permissions.deny rule and no PreToolUse hook in ${ROOT_CONFIG}`,
  );
}

/** One Observation under a Pack Rule, its summary ending with the Rule's fix. A whole-repo one has no line. */
function observation(
  asset: Asset,
  ruleId: RuleId,
  path: string,
  line: number | undefined,
  summary: string,
): Observation {
  const rule = packRule(ruleId);
  return {
    asset,
    rule_id: rule.ruleId,
    location: line === undefined ? { kind: "file", path } : { kind: "file", path, line },
    severity: rule.severity,
    title: rule.title,
    evidence: { summary: `${summary}. To fix: ${rule.fix}` },
  };
}
