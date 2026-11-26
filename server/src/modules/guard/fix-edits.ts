// Guard's fixed edit per Rule (spec #224, story 6): the change a Fix PR makes to the one file its Finding sits in, or
// why there's no Fix PR. Each edit is one its Rule's own scanner then reports nothing for: the scanner's own patterns
// (`isBroadBashAllow`, `serverStart`, `isPinnedPackage`) decide what is changed. An edited file is written back as
// JSON with its keys in the same order, two-space indented, with a trailing newline; Warden never overwrites a value
// of a type Claude Code wouldn't read. A PR body line names a server by its key and package only, never another
// argument, an env value or a URL, which can hold a token.
import type { Location, RuleId } from "@warden/contracts";
import { isBroadBashAllow, isClaudeSettingsFile, WHOLE_REPO_PATH } from "./agent-config.ts";
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
import { isPackageName, type PackageRegistry } from "./package-registry.ts";

/** A Fix PR's change: the file it writes, its new text, and the lines for the PR body; or why there's none. */
export type FixedEdit =
  { ok: true; path: string; text: string; body: string[] } | { ok: false; reason: string };

const NO_FIX_PR = "no Fix PR for this Rule";
const NEVER_WORKFLOWS = "Warden never edits .github/workflows/";
const NOT_JSON = "isn't valid JSON";
const MISSING = "the file isn't on the default branch";
const ALREADY_FIXED = "already fixed on the default branch; the next Scan marks it Fixed";

/** The deny entries that stop the agent reading the root `.env` and `.env.local` and the like. */
const ENV_DENY = ["Read(./.env)", "Read(./.env.*)"];

const refused = (reason: string): FixedEdit => ({ ok: false, reason });

/** JSON as an edit writes it: two-space indented, with a trailing newline. */
const written = (config: Record<string, unknown>) => `${JSON.stringify(config, null, 2)}\n`;

/**
 * Text as a Markdown code span, so a name a repo makes up can't mention anyone, link or format: fenced by one more
 * backtick than its longest run, and padded when it starts or ends with one.
 */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
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
  if (location.kind !== "file") return refused(NO_FIX_PR);
  const { path } = location;
  if (/(?:^|\/)\.github\/workflows\//.test(path)) return refused(NEVER_WORKFLOWS);
  switch (ruleId) {
    case AGENT_CAN_READ_ENV:
    case NO_RUNTIME_GUARD:
      return path === WHOLE_REPO_PATH ? denyEnv(current) : refused(NO_FIX_PR);
    case BLANKET_BASH_ALLOW:
      return isClaudeSettingsFile(path) ? removeBroadBash(path, current) : refused(NO_FIX_PR);
    case MCP_SERVER_UNPINNED:
      return isMcpConfigPath(path) ? pinServers(path, current, registry) : refused(NO_FIX_PR);
    default:
      return refused(NO_FIX_PR);
  }
}

/** Adds the `.env` deny entries to the root settings file, creating the file, `permissions` or `deny` as needed. */
function denyEnv(current: string | undefined): FixedEdit {
  const config = current === undefined ? {} : readJsonObject(current)?.config;
  if (config === undefined) return refused(`${WHOLE_REPO_PATH} ${NOT_JSON}`);
  // A key that's there with another type, `null` included, is refused rather than replaced.
  const permissions = config.permissions === undefined ? {} : config.permissions;
  if (!isObject(permissions)) return refused(notReadable("permissions"));
  const deny = permissions.deny === undefined ? [] : permissions.deny;
  if (!Array.isArray(deny)) return refused(notReadable("permissions.deny"));
  const added = ENV_DENY.filter((entry) => !deny.includes(entry));
  if (added.length === 0) return refused(ALREADY_FIXED);
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
  const config = readJsonObject(current)?.config;
  if (config === undefined) return refused(`${path} ${NOT_JSON}`);
  const { permissions } = config;
  const allow = isObject(permissions) && Array.isArray(permissions.allow) ? permissions.allow : [];
  const broad = (entry: unknown): entry is string =>
    typeof entry === "string" && isBroadBashAllow(entry);
  const removed = allow.filter(broad);
  if (removed.length === 0 || !isObject(permissions)) return refused(ALREADY_FIXED);
  permissions.allow = allow.filter((entry) => !broad(entry));
  return {
    ok: true,
    path,
    text: written(config),
    body: [
      `Removes the broad Bash allows from \`permissions.allow\` in ${code(path)}:`,
      ...removed.map((entry) => `- ${code(entry)}`),
      "Add back the exact commands the agent needs, such as `Bash(npm test)`.",
    ],
  };
}

/** A package word split into its name and what follows it, ready to be pinned; undefined when it can't be. */
type Package = { name: string; spell(version: string): string };

/** An npm package word: `name`, `@scope/name`, either with `@<tag or range>`; never a URL, path or alias. */
function npmPackage(word: string): Package | undefined {
  const at = word.indexOf("@", 1);
  const name = at < 0 ? word : word.slice(0, at);
  const spec = at < 0 ? "" : word.slice(at + 1);
  if (!isPackageName("npm", name) || /[:/]/.test(spec)) return undefined;
  return { name, spell: (version) => `${name}@${version}` };
}

/** A Python requirement: a name, its extras, then nothing, a version specifier list, or uv's `@<version>`. */
const PYTHON_REQUIREMENT =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[A-Za-z0-9._,\s-]*\])?((?:\s*(?:===|[=!~<>]=|[<>])\s*[A-Za-z0-9.*+!_-]+\s*,?)*|@[A-Za-z0-9.+!_-]+)$/;

/**
 * A Python package word, spelled at a version as its runner's docs give it in that place: uv's command argument as
 * `name@version` (`uvx ruff@0.3.0`), and `--from`, `--spec` and pipx's package as `name==version`
 * (`--from 'mypy[reports]==1.13.0'`), extras kept in each.
 */
function pythonPackage(word: string, start: ServerStart): Package | undefined {
  const match = PYTHON_REQUIREMENT.exec(word);
  if (match === null) return undefined;
  const [, name = "", extras = ""] = match;
  const uvCommand = start.positional && start.runner[0] !== "pipx";
  return { name, spell: (version) => `${name}${extras}${uvCommand ? "@" : "=="}${version}` };
}

/** What became of one unpinned server: pinned to a new word, or left as it is with the reason. */
type Outcome = { key: string; pinned: string } | { key: string; left: string };

const REGISTRY_NAMES: Record<PackageRegistryName, string> = { npm: "npm", pypi: "PyPI" };

/**
 * Pins each `mcpServers` server an npm or a Python runner starts unpinned to its registry's latest version, where its
 * package word sits. Container images, and packages their registry doesn't hold, are left and listed.
 */
async function pinServers(
  path: string,
  current: string | undefined,
  registry: PackageRegistry,
): Promise<FixedEdit> {
  if (current === undefined) return refused(MISSING);
  const config = readJsonObject(current)?.config;
  if (config === undefined) return refused(`${path} ${NOT_JSON}`);
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  const latest = new Map<string, Promise<string | undefined>>();
  const lookup = (name: PackageRegistryName, pkg: string) => {
    const key = `${name}:${pkg}`;
    if (!latest.has(key)) latest.set(key, registry.latestVersion(name, pkg));
    return latest.get(key)!;
  };
  const outcomes: Outcome[] = [];
  for (const [key, entry] of Object.entries(servers)) {
    const start = serverStart(entry);
    if (start === undefined || start.pinned || !isObject(entry)) continue;
    outcomes.push({ key, ...(await pinServer(entry, start, lookup)) });
  }
  if (outcomes.length === 0) return refused(ALREADY_FIXED);
  const pinned = outcomes.filter((outcome) => "pinned" in outcome);
  if (pinned.length === 0) {
    return refused(
      "no server can be pinned: each unpinned one is a container image or not on its registry",
    );
  }
  const left = outcomes.filter((outcome) => "left" in outcome);
  return {
    ok: true,
    path,
    text: written(config),
    body: [
      `Pins each MCP server's package in ${code(path)} to its registry's latest version, so a new release, or whoever takes over the package's name, doesn't run with the agent's access:`,
      ...pinned.map(({ key, pinned }) => `- ${code(key)}: ${code(pinned)}`),
      ...(left.length === 0
        ? []
        : ["Left as they are:", ...left.map(({ key, left }) => `- ${code(key)}: ${left}`)]),
    ],
  };
}

/** Pins one server's package in place in `entry`, or says why it's left. */
async function pinServer(
  entry: Record<string, unknown>,
  start: ServerStart,
  lookup: (registry: PackageRegistryName, name: string) => Promise<string | undefined>,
): Promise<{ pinned: string } | { left: string }> {
  if (start.registry === "container") return { left: "a container image gets no Fix PR" };
  const name = REGISTRY_NAMES[start.registry];
  const pkg =
    start.registry === "npm" ? npmPackage(start.target) : pythonPackage(start.target, start);
  if (pkg === undefined) return { left: `not a package Warden can pin from ${name}` };
  const version = await lookup(start.registry, pkg.name);
  if (version === undefined) return { left: `${name} doesn't hold ${code(pkg.name)}` };
  const pinned = pkg.spell(version);
  if (!isPinnedPackage(start.registry, pinned)) {
    return { left: `not a package Warden can pin from ${name}` };
  }
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
