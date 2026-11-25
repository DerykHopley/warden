// Guard's MCP server Rule (Guard spec, story 3): a `.mcp.json` server that a package runner (`npx`, `uvx`, …) or a
// container runtime (`docker run`, `podman run`) starts without a pinned version, so the next release, or whoever
// takes over the package's name, runs with the agent's access. The file is read as Claude Code reads it, through its
// `mcpServers` key; a file that isn't valid JSON holds no server. A server that isn't started from a package (a remote
// `url`, `node ./server.js`) is never flagged. A summary names servers only by their key, never by an argument, an env
// value or a URL, which can hold a token.
import type { Asset, Observation } from "@warden/contracts";
import { valueLines } from "./agent-config.ts";
import { MCP_SERVER_UNPINNED, packRule } from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A project's MCP config: `.mcp.json` in any folder. */
const MCP_FILE = /(?:^|\/)\.mcp\.json$/;

/** npm-style runners: the package is `-p` / `--package`'s value, else the first argument. */
const NPM_RUNNERS = [["npx"], ["bunx"], ["pnpm", "dlx"], ["yarn", "dlx"], ["npm", "exec"]];
/** Python runners: the package is `--from` / `--spec`'s value, else the first argument. */
const PYTHON_RUNNERS = [["uvx"], ["uv", "tool", "run"], ["pipx", "run"]];
/** Container runtimes: the image is the first argument after `run` that isn't an option or its value. */
const CONTAINER_RUNNERS = [
  ["docker", "run"],
  ["podman", "run"],
];

/** `docker run` / `podman run` options whose value, given as a separate argument, comes before the image. */
const CONTAINER_VALUE_OPTIONS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "--mount",
  "--name",
  "--network",
  "-p",
  "--publish",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "--platform",
  "--entrypoint",
]);

/** A package at an exact version, `name@1.2.3` or `@scope/name@1.2.3-beta.1`: no tag and no range. */
const NPM_PINNED = /^(?:@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A Python package at an exact version, `name==0.4.1` or `name@0.4.1`, pre-releases included. */
const PYTHON_PINNED = /(?:==|@)\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;

/** How much of a server's key a summary shows, so a made-up long key can't outgrow the evidence. */
const KEY_SHOWN = 64;
/** How many unpinned servers a summary names before counting the rest. */
const NAMED = 3;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The words after `runner` when `words` start with it. */
function after(words: readonly string[], runner: readonly string[]): string[] | undefined {
  return runner.every((word, i) => words[i] === word) ? words.slice(runner.length) : undefined;
}

/** An option's value, given as the next argument or after `=`. */
function optionValue(rest: readonly string[], names: readonly string[]): string | undefined {
  for (const [i, word] of rest.entries()) {
    if (names.includes(word)) return rest[i + 1];
    const named = names.find((name) => name.startsWith("--") && word.startsWith(`${name}=`));
    if (named !== undefined) return word.slice(named.length + 1);
  }
  return undefined;
}

const firstArgument = (rest: readonly string[]) => rest.find((word) => !word.startsWith("-"));

function containerImage(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (!word.startsWith("-")) return word;
    if (CONTAINER_VALUE_OPTIONS.has(word)) i += 1;
  }
  return undefined;
}

/** An image with a digest, or a tag other than `latest`. A registry's port (`host:5000/name`) isn't a tag. */
function imagePinned(image: string): boolean {
  const at = image.indexOf("@");
  if (at >= 0) return DIGEST.test(image.slice(at + 1));
  const name = image.slice(image.lastIndexOf("/") + 1);
  const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : "";
  return tag !== "" && tag !== "latest";
}

/**
 * Whether a server is started from a package or an image without a pinned version. Its `command`, split on white
 * space, then its string `args`, read after a leading `cmd /c`. A server with no package or image, or not started by
 * a runner, isn't.
 */
function runsUnpinned(entry: unknown): boolean {
  if (!isObject(entry) || typeof entry.command !== "string") return false;
  // Claude Code reads an entry with a `type` other than stdio as a remote server, whatever else it holds.
  if (typeof entry.type === "string" && entry.type !== "stdio") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  let words = [
    ...entry.command.split(/\s+/).filter((word) => word !== ""),
    ...args.filter((arg): arg is string => typeof arg === "string"),
  ];
  if (/^cmd(?:\.exe)?$/i.test(words[0] ?? "") && /^\/c$/i.test(words[1] ?? ""))
    words = words.slice(2);
  for (const runner of NPM_RUNNERS) {
    const rest = after(words, runner);
    if (rest === undefined) continue;
    const pkg = optionValue(rest, ["-p", "--package"]) ?? firstArgument(rest);
    return pkg !== undefined && !NPM_PINNED.test(pkg);
  }
  for (const runner of PYTHON_RUNNERS) {
    const rest = after(words, runner);
    if (rest === undefined) continue;
    const pkg = optionValue(rest, ["--from", "--spec"]) ?? firstArgument(rest);
    return pkg !== undefined && !PYTHON_PINNED.test(pkg);
  }
  for (const runner of CONTAINER_RUNNERS) {
    const rest = after(words, runner);
    if (rest === undefined) continue;
    const image = containerImage(rest);
    return image !== undefined && !imagePinned(image);
  }
  return false;
}

/** The keys of a `.mcp.json`'s servers that run without a pinned version; none for a file Claude Code wouldn't read. */
function unpinnedServers(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(parsed) || !isObject(parsed.mcpServers)) return [];
  return Object.entries(parsed.mcpServers).flatMap(([key, entry]) =>
    runsUnpinned(entry) ? [key] : [],
  );
}

const shown = (key: string) => (key.length > KEY_SHOWN ? `${key.slice(0, KEY_SHOWN - 1)}…` : key);

/**
 * What one file's MCP servers come to: none, or one Observation for all its unpinned servers, as a file's secrets
 * share one. Its line is the first unpinned server's key; its summary counts them, names up to three by key and ends
 * with the Pack's fix.
 */
export function mcpServerObservations(asset: Asset, { path, text: raw }: RepoFile): Observation[] {
  if (!MCP_FILE.test(path)) return [];
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  const servers = unpinnedServers(text);
  const [first] = servers;
  if (first === undefined) return [];
  const line = valueLines(text, 2).get(JSON.stringify(["mcpServers", first])) ?? 1;
  const rule = packRule(MCP_SERVER_UNPINNED);
  const count = servers.length;
  const named = servers.slice(0, NAMED).map(shown).join(", ");
  const more = count > NAMED ? ` and ${count - NAMED} more` : "";
  const where = count === 1 ? `on line ${line}` : `first on line ${line}`;
  return [
    {
      asset,
      rule_id: rule.ruleId,
      location: { kind: "file", path, line },
      severity: rule.severity,
      title: rule.title,
      evidence: {
        summary: `${count} ${count === 1 ? "MCP server" : "MCP servers"} without a pinned version (${named}${more}) in ${path}, ${where}. To fix: ${rule.fix}`,
      },
    },
  ];
}
