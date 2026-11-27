// Guard's fixed edit per Rule (spec #224, story 6): the change a Fix PR makes to the one file its Finding sits in, or
// why there's no Fix PR. Each edit is one its Rule's own scanner then reports nothing for: the scanner's own patterns
// (`isBroadBashAllow`, `serverStart`, `isPinnedPackage`) decide what is changed. An edited file is written back as
// JSON with its keys in the same order, two-space indented, with a trailing newline, and refused when writing it back
// would change anything else in it; Warden never overwrites a value of a type Claude Code wouldn't read. A PR body
// line names a server by its key and package only, never another argument, an env value or a URL, which can hold a
// token, and each name sits on one line in a code span.
import type { Location, RuleId } from "@warden/contracts";
import {
  isBroadBashAllow,
  isClaudeSettingsFile,
  settingsClear,
  WHOLE_REPO_PATH,
} from "./agent-config.ts";
import {
  AGENT_CAN_READ_ENV,
  BLANKET_BASH_ALLOW,
  MCP_SERVER_UNPINNED,
  NO_RUNTIME_GUARD,
} from "./default-pack.ts";
import { isObject, readJsonObject } from "./json-config.ts";
import {
  isMcpConfigPath,
  isPinnedPackage,
  serverStart,
  type PackageRegistryName,
  type ServerStart,
} from "./mcp-servers.ts";
import { isPackageName, UnpinnableVersion, type PackageRegistry } from "./package-registry.ts";

/** A Fix PR's change: the file it writes, its new text, and the lines for the PR body; or why there's none. */
export type FixedEdit =
  { ok: true; path: string; text: string; body: string[] } | { ok: false; reason: string };

/** Why a Rule, or a Location that isn't a file, gets no Fix PR. */
export const NO_FIX_PR = "no Fix PR for this Rule";
const NEVER_WORKFLOWS = "Warden never edits .github/workflows/";
const NOT_JSON = "isn't valid JSON";
const MISSING = "the file isn't on the default branch";
const ALREADY_FIXED = "already fixed on the default branch; the next Scan marks it Fixed";
const UNCHANGED = "Warden never changes what its edit doesn't mean to";
/** A PR that leaves a server unpinned doesn't clear the Finding: its Rule still sees that server on the next Scan. */
const STAYS_OPEN =
  "The Finding stays Open after this PR merges, until the servers left as they are are pinned by hand.";
const RANGED = "names a version range or tag, which pinning to the latest version could downgrade";

const notPinnable = (label: string) => `not a package Warden can pin from ${label}`;
const unpinnableVersion = (label: string, name: string) =>
  `${label}'s latest version of ${code(name)} isn't one Warden can write as pinned`;

/** The deny entries that stop the agent reading the root `.env` and `.env.local` and the like. */
const ENV_DENY = ["Read(./.env)", "Read(./.env.*)"];

const refused = (reason: string): FixedEdit => ({ ok: false, reason });

/** JSON as an edit writes it: two-space indented, with a trailing newline. */
const written = (config: Record<string, unknown>) => `${JSON.stringify(config, null, 2)}\n`;

/** A JSON text's tokens: strings, numbers, literals and punctuation, white space skipped. */
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g;

/**
 * Why writing a file's JSON `text` back would change it beyond the edit, or undefined when it wouldn't. `JSON.parse`
 * reads a number past a double's precision or range, `-0`, and a spelling like `1.50` or `1e2` as a number
 * `JSON.stringify` writes another way; it puts integer-like keys first, and keeps only a repeated key's last value.
 * Strings are compared by their value, so an escape like `\/` written back as `/` changes nothing.
 */
function rewriteChanges(path: string, text: string): string | undefined {
  const tokens = text.match(JSON_TOKEN) ?? [];
  if (tokens.some((token) => /^-?\d/.test(token) && JSON.stringify(Number(token)) !== token)) {
    return `${path} holds a number that rewriting it as JSON would change; ${UNCHANGED}`;
  }
  const same = tokens
    .map((token) => (token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : token))
    .join("");
  return same === JSON.stringify(JSON.parse(text))
    ? undefined
    : `${path}'s keys would move or be dropped when it's rewritten as JSON; ${UNCHANGED}`;
}

/** A C0 or C1 control character, or a Unicode line or paragraph separator: each could end a body line. */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** Text with each character that could end its line written as its `\u` escape, so it stays on one line. */
const oneLine = (text: string) =>
  text.replace(LINE_BREAKING, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * Text as a Markdown code span on one line, so a name a repo makes up can't mention anyone, link, format or start a
 * line of its own: each character that could end a line written as its `\u` escape, then fenced by one more backtick
 * than its longest run, and padded when it starts or ends with one.
 */
function code(raw: string): string {
  const text = oneLine(raw);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A Rule's Fix PR: whether a path is the file it edits, and its edit of that file's `current` text. */
type RuleFix = {
  isFile(path: string): boolean;
  edit(path: string, current: string | undefined, registry: PackageRegistry): Promise<FixedEdit>;
};

/** A whole-repo Rule's Fix PR: the `.env` deny entries, unless the root settings file already clears that Rule. */
const denyEnvFix = (ruleId: RuleId): RuleFix => ({
  isFile: (path) => path === WHOLE_REPO_PATH,
  edit: async (_path, current) => denyEnv(ruleId, current),
});

/** Each Rule that gets a Fix PR; a Rule not here gets none. */
const FIXES = new Map<RuleId, RuleFix>([
  [AGENT_CAN_READ_ENV, denyEnvFix(AGENT_CAN_READ_ENV)],
  [NO_RUNTIME_GUARD, denyEnvFix(NO_RUNTIME_GUARD)],
  [
    BLANKET_BASH_ALLOW,
    { isFile: isClaudeSettingsFile, edit: async (path, current) => removeBroadBash(path, current) },
  ],
  [MCP_SERVER_UNPINNED, { isFile: isMcpConfigPath, edit: pinServers }],
]);

/**
 * Why the Finding at `location` under `ruleId` gets no Fix PR whatever its file holds, or undefined when it may get
 * one: not a file Location, a path under `.github/workflows/`, a Rule with no fixed edit, or a path that isn't the
 * Rule's file. `fixedEdit` asks this first, so whether a Finding is fixable never disagrees with its edit.
 */
export function fixRefusal(ruleId: RuleId, location: Location): string | undefined {
  if (location.kind !== "file") return NO_FIX_PR;
  if (/(?:^|\/)\.github\/workflows\//.test(location.path)) return NEVER_WORKFLOWS;
  return FIXES.get(ruleId)?.isFile(location.path) ? undefined : NO_FIX_PR;
}

/**
 * The change a Fix PR for the Finding at `location` under `ruleId` makes, from the file's `current` text (undefined
 * when it's missing). `registry` gives a package's latest version for `guard/mcp-server-unpinned`; its
 * RegistryUnavailable is passed up, not caught.
 */
export async function fixedEdit(
  ruleId: RuleId,
  location: Location,
  current: string | undefined,
  registry: PackageRegistry,
): Promise<FixedEdit> {
  const refusal = fixRefusal(ruleId, location);
  const fix = FIXES.get(ruleId);
  if (refusal !== undefined || location.kind !== "file" || fix === undefined) {
    return refused(refusal ?? NO_FIX_PR);
  }
  return fix.edit(location.path, current, registry);
}

/**
 * Adds the `.env` deny entries to the root settings file, creating the file, `permissions` or `deny` as needed. A file
 * that already clears `ruleId` by its scanner's own match (`settingsClear`) is already fixed.
 */
function denyEnv(ruleId: RuleId, current: string | undefined): FixedEdit {
  const read =
    current === undefined
      ? { text: "{}", config: {} as Record<string, unknown> }
      : readJsonObject(current);
  if (read === undefined) return refused(`${WHOLE_REPO_PATH} ${NOT_JSON}`);
  if (settingsClear(ruleId, read.text)) return refused(ALREADY_FIXED);
  const { config } = read;
  // A key that's there with another type, `null` included, is refused rather than replaced.
  const permissions = config.permissions === undefined ? {} : config.permissions;
  if (!isObject(permissions)) return refused(notReadable("permissions"));
  const deny = permissions.deny === undefined ? [] : permissions.deny;
  if (!Array.isArray(deny)) return refused(notReadable("permissions.deny"));
  const added = ENV_DENY.filter((entry) => !deny.includes(entry));
  const changes = rewriteChanges(WHOLE_REPO_PATH, read.text);
  if (changes !== undefined) return refused(changes);
  permissions.deny = [...(deny as unknown[]), ...added];
  config.permissions = permissions;
  return {
    ok: true,
    path: WHOLE_REPO_PATH,
    text: written(config),
    body: [
      `Adds ${added.map(code).join(" and ")} to \`permissions.deny\` in ${code(WHOLE_REPO_PATH)}, so the agent can't read the repo's \`.env\` files.`,
      "A deny rule also means Claude Code checks the agent's tool calls against it.",
    ],
  };
}

const notReadable = (key: string) =>
  `${WHOLE_REPO_PATH}'s ${code(key)} isn't in the shape Claude Code reads; Warden never overwrites it`;

/** Removes each broad Bash allow from a settings file, keeping every other entry and key. */
function removeBroadBash(path: string, current: string | undefined): FixedEdit {
  if (current === undefined) return refused(MISSING);
  const read = readJsonObject(current);
  if (read === undefined) return refused(`${path} ${NOT_JSON}`);
  const { permissions } = read.config;
  const allow = isObject(permissions) && Array.isArray(permissions.allow) ? permissions.allow : [];
  const broad = (entry: unknown): entry is string =>
    typeof entry === "string" && isBroadBashAllow(entry);
  const removed = allow.filter(broad);
  if (removed.length === 0 || !isObject(permissions)) return refused(ALREADY_FIXED);
  const changes = rewriteChanges(path, read.text);
  if (changes !== undefined) return refused(changes);
  permissions.allow = allow.filter((entry) => !broad(entry));
  return {
    ok: true,
    path,
    text: written(read.config),
    body: [
      `Removes the broad Bash allows from \`permissions.allow\` in ${code(path)}:`,
      ...removed.map((entry) => `- ${code(entry)}`),
      "Add back the exact commands the agent needs, such as `Bash(npm test)`.",
    ],
  };
}

/**
 * A package word split into its name and how it's spelled at a version, and whether it names a version range or a
 * tag (`pkg@^3`, `pkg@next`, `name>=1`) rather than none or `latest`; undefined when it can't be read as a package.
 */
type Package = { name: string; ranged: boolean; spell(version: string): string };

/** An npm package word: `name`, `@scope/name`, either with `@<tag or range>`; never a URL, path or alias. */
function npmPackage({ target }: ServerStart): Package | undefined {
  const at = target.indexOf("@", 1);
  const name = at < 0 ? target : target.slice(0, at);
  const spec = at < 0 ? "" : target.slice(at + 1);
  if (!isPackageName("npm", name) || /[:/]/.test(spec)) return undefined;
  return {
    name,
    ranged: spec !== "" && spec !== "latest",
    spell: (version) => `${name}@${version}`,
  };
}

/**
 * A Python requirement: a name (checked by `isPackageName`), its extras, then nothing, a version specifier list, or
 * uv's `@<version>`.
 */
const PYTHON_REQUIREMENT =
  /^([^[\]=!~<>@\s;]+)(\[[A-Za-z0-9._,\s-]*\])?((?:\s*(?:===|[=!~<>]=|[<>])\s*[A-Za-z0-9.*+!_-]+\s*,?)*|@[A-Za-z0-9.+!_-]+)$/;

/**
 * A Python package word, spelled at a version as its runner's docs give it in that place: uv's command argument as
 * `name@version` (`uvx ruff@0.3.0`), and `--from`, `--spec` and pipx's package as `name==version`
 * (`--from 'mypy[reports]==1.13.0'`), extras kept in each. uv's `@latest` is no range.
 */
function pythonPackage(start: ServerStart): Package | undefined {
  const match = PYTHON_REQUIREMENT.exec(start.target);
  if (match === null) return undefined;
  const [, name = "", extras = "", spec = ""] = match;
  if (!isPackageName("pypi", name)) return undefined;
  const uvCommand = start.positional && start.runner[0] !== "pipx";
  return {
    name,
    ranged: spec !== "" && spec !== "@latest",
    spell: (version) => `${name}${extras}${uvCommand ? "@" : "=="}${version}`,
  };
}

/** Each registry's name as the PR body gives it, and how a server's package word is read for it. */
const PACKAGES: Record<
  PackageRegistryName,
  { label: string; read(start: ServerStart): Package | undefined }
> = {
  npm: { label: "npm", read: npmPackage },
  pypi: { label: "PyPI", read: pythonPackage },
};

/** What became of one unpinned server: pinned to a new word, or left as it is with the reason. */
type Outcome = { key: string; pinned: string } | { key: string; left: string };

/**
 * Pins each `mcpServers` server an npm or a Python runner starts unpinned to its registry's latest version, where its
 * package word sits. Container images, servers whose runner is pointed at another registry, packages their registry
 * doesn't hold, and packages that name a range or tag are left and listed.
 */
async function pinServers(
  path: string,
  current: string | undefined,
  registry: PackageRegistry,
): Promise<FixedEdit> {
  if (current === undefined) return refused(MISSING);
  const read = readJsonObject(current);
  if (read === undefined) return refused(`${path} ${NOT_JSON}`);
  const { config } = read;
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  const unpinned = Object.entries(servers).flatMap(([key, entry]) => {
    const start = serverStart(entry);
    return start === undefined || start.pinned || !isObject(entry) ? [] : [{ key, entry, start }];
  });
  if (unpinned.length === 0) return refused(ALREADY_FIXED);
  const changes = rewriteChanges(path, read.text);
  if (changes !== undefined) return refused(changes);
  const latest = new Map<string, Promise<string | undefined>>();
  const lookup = (registryName: PackageRegistryName, name: string) => {
    const key = `${registryName}:${name}`;
    if (!latest.has(key)) latest.set(key, registry.latestVersion(registryName, name));
    return latest.get(key)!;
  };
  const outcomes: Outcome[] = [];
  for (const { key, entry, start } of unpinned) {
    outcomes.push({ key, ...(await pinServer(entry, start, lookup)) });
  }
  const pinned = outcomes.filter((outcome) => "pinned" in outcome);
  const left = outcomes.filter((outcome) => "left" in outcome);
  if (pinned.length === 0) {
    return refused(
      `no server can be pinned: ${left.map(({ key, left }) => `${code(key)}: ${left}`).join("; ")}`,
    );
  }
  return {
    ok: true,
    path,
    text: written(config),
    body: [
      `Pins each MCP server's package in ${code(path)} to its registry's latest version, so a new release, or whoever takes over the package's name, doesn't run with the agent's access:`,
      ...pinned.map(({ key, pinned }) => `- ${code(key)}: ${code(pinned)}`),
      ...(left.length === 0
        ? []
        : [
            "Left as they are:",
            ...left.map(({ key, left }) => `- ${code(key)}: ${left}`),
            STAYS_OPEN,
          ]),
    ],
  };
}

/** Pins one server's package in place in `entry`, or says why it's left. */
async function pinServer(
  entry: Record<string, unknown>,
  start: ServerStart,
  lookup: (registry: PackageRegistryName, name: string) => Promise<string | undefined>,
): Promise<{ pinned: string } | { left: string }> {
  const { source } = start;
  if (source === "container") return { left: "a container image gets no Fix PR" };
  // The public registry's latest version of a name its runner installs from somewhere else could be anyone's (#348).
  if (start.customRegistry !== undefined) {
    return { left: `uses a private registry (${code(start.customRegistry)})` };
  }
  const { label, read } = PACKAGES[source];
  const pkg = read(start);
  if (pkg === undefined) return { left: notPinnable(label) };
  if (pkg.ranged) return { left: RANGED };
  let version;
  try {
    version = await lookup(source, pkg.name);
  } catch (error) {
    if (error instanceof UnpinnableVersion) return { left: unpinnableVersion(label, pkg.name) };
    throw error;
  }
  if (version === undefined) return { left: `${label} doesn't hold ${code(pkg.name)}` };
  const pinned = pkg.spell(version);
  if (!isPinnedPackage(source, pinned)) return { left: unpinnableVersion(label, pkg.name) };
  const word = `${start.prefix}${pinned}`;
  const { at } = start;
  if (at.field === "args") {
    (entry.args as unknown[])[at.index] = word;
  } else {
    const command = entry.command as string;
    entry.command = `${command.slice(0, at.start)}${word}${command.slice(at.end)}`;
  }
  return { pinned };
}
