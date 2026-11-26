// Guard's MCP server Rule (Guard spec, story 3): a `.mcp.json` server that a package runner (`npx`, `uvx`, …) or a
// container runtime (`docker run`, `podman run`) starts without a pinned version, so the next release, or whoever
// takes over the package's name, runs with the agent's access. The file is read as Claude Code reads it, through its
// `mcpServers` key; a file that isn't valid JSON holds no server. A server that isn't started from a package (a remote
// `url`, `node ./server.js`, a runner given a local path) is never flagged. A summary names servers only by their key,
// never by an argument, an env value or a URL, which can hold a token.
import type { Asset, Observation } from "@warden/contracts";
import { valueLines } from "./agent-config.ts";
import { MCP_SERVER_UNPINNED, packRule } from "./default-pack.ts";
import { isObject, readJsonObject } from "./json-config.ts";
import type { RepoFile } from "./repo-reader.ts";

/** A project's MCP config: `.mcp.json` in any folder. */
const MCP_FILE = /(?:^|\/)\.mcp\.json$/;

/** `uv tool run` / `uvx` and `pipx run` options whose value, given as a separate argument, comes before the package. */
const PYTHON_VALUE_OPTIONS = new Set([
  // uv tool run
  "-w",
  "--with",
  "--with-editable",
  "--with-requirements",
  "-c",
  "--constraint",
  "--constraints",
  "-b",
  "--build-constraints",
  "--overrides",
  "--env-file",
  "--python-platform",
  "--torch-backend",
  "--index",
  "--default-index",
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "--index-strategy",
  "--keyring-provider",
  "-P",
  "--upgrade-package",
  "--upgrade-group",
  "--resolution",
  "--prerelease",
  "--prerelease-package",
  "--fork-strategy",
  "--exclude-newer",
  "--exclude-newer-package",
  "--no-sources-package",
  "--reinstall-package",
  "--link-mode",
  "-C",
  "--config-setting",
  "--config-settings-package",
  "--no-build-isolation-package",
  "--no-build-package",
  "--no-binary-package",
  "--cache-dir",
  "--refresh-package",
  "-p",
  "--python",
  "--color",
  "--allow-insecure-host",
  "--directory",
  "--project",
  "--config-file",
  // pipx run, beside the ones it shares
  "--python-args",
  "--fetch-python",
  "--pip-args",
  "--cooldown",
  "--backend",
]);

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
  "--add-host",
  "-l",
  "--label",
  "--label-file",
  "-h",
  "--hostname",
  "--cap-add",
  "--cap-drop",
  "--log-driver",
  "--log-opt",
  "--pull",
  "--device",
  "-m",
  "--memory",
  "--cpus",
  "--restart",
  "--tmpfs",
  "--ulimit",
  "--dns",
  "--gpus",
  "--shm-size",
]);

/** A package at an exact version, `name@1.2.3` or `@scope/name@1.2.3-beta.1`: no tag and no range. */
const NPM_PINNED = /^(?:@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A Python package at an exact version, `name==0.4.1` or `name@0.4.1`, pre-releases included. */
const PYTHON_PINNED = /(?:==|@)\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
/** A local path (`./server`, `/opt/mcp`, `~/mcp`, `C:\mcp`): a local server, not a package. */
const LOCAL_PATH = /^(?:[.~/\\]|[A-Za-z]:[\\/])/;

/** The most characters of a server's key a summary shows, so a made-up long key can't outgrow the evidence. */
const SUMMARY_KEY_MAX = 64;
/** The most unpinned servers a summary names by key before counting the rest. */
const SUMMARY_KEYS_MAX = 3;

/** One kind of runner: the command words that start it, what it starts, and when that is at an exact version. */
type RunnerKind = {
  runners: readonly (readonly string[])[];
  /** The package or image it starts, from the words after the runner; undefined when there is none. */
  target(rest: readonly string[]): string | undefined;
  pinned(target: string): boolean;
};

const RUNNER_KINDS: readonly RunnerKind[] = [
  {
    runners: [["npx"], ["bunx"], ["pnpm", "dlx"], ["yarn", "dlx"], ["npm", "exec"]],
    target: (rest) => runnerTarget(rest, ["-p", "--package"], new Set()),
    pinned: (pkg) => NPM_PINNED.test(pkg),
  },
  {
    runners: [["uvx"], ["uv", "tool", "run"], ["pipx", "run"]],
    target: (rest) => runnerTarget(rest, ["--from", "--spec"], PYTHON_VALUE_OPTIONS),
    pinned: (pkg) => PYTHON_PINNED.test(pkg),
  },
  {
    runners: [
      ["docker", "run"],
      ["podman", "run"],
    ],
    target: (rest) => runnerTarget(rest, [], CONTAINER_VALUE_OPTIONS),
    pinned: imagePinned,
  },
];

/** The commands that start a runner, by `commandName`. */
const RUNNER_COMMANDS = new Set(
  RUNNER_KINDS.flatMap(({ runners }) => runners.map(([first]) => first)),
);

/** A command's name: its last path segment, without a Windows `.cmd` or `.exe` ending (in any case). */
function commandName(command: string): string {
  const name = command.slice(Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\")) + 1);
  return name.replace(/\.(?:cmd|exe)$/i, "");
}

const isCmd = (command: string | undefined) =>
  command !== undefined && commandName(command).toLowerCase() === "cmd";

/**
 * A server's command line as words: its `command`, then its string `args`, read after a leading `cmd /c`. The command
 * is one word when the whole of it names a runner or `cmd`, as a path with a space does (`C:\Program
 * Files\nodejs\npx.cmd`); otherwise it is split on white space (`npx -y some-mcp-server`).
 */
function commandLine(command: string, args: unknown): string[] {
  const whole = command.trim();
  const words = [
    ...(RUNNER_COMMANDS.has(commandName(whole)) || isCmd(whole)
      ? [whole]
      : whole.split(/\s+/).filter((word) => word !== "")),
    ...(Array.isArray(args) ? args : []).filter((arg): arg is string => typeof arg === "string"),
  ];
  return isCmd(words[0]) && /^\/c$/i.test(words[1] ?? "") ? words.slice(2) : words;
}

/** The words after `runner` when `words` start with it: its command by `commandName`, the words after it exactly. */
function argsAfterRunner(
  words: readonly string[],
  runner: readonly string[],
): string[] | undefined {
  const [command, ...subcommand] = runner;
  if (words[0] === undefined || commandName(words[0]) !== command) return undefined;
  return subcommand.every((word, i) => words[i + 1] === word)
    ? words.slice(runner.length)
    : undefined;
}

/**
 * What a runner starts: the value of one of `fromOptions` (`-p x`, `--package=x`) given before the first argument, else
 * that first argument, an argument that isn't an option or the separate value of one of `valueOptions`. What comes
 * after it is the server's own.
 */
function runnerTarget(
  rest: readonly string[],
  fromOptions: readonly string[],
  valueOptions: ReadonlySet<string>,
): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (fromOptions.includes(word)) return rest[i + 1];
    const from = fromOptions.find((name) => name.startsWith("--") && word.startsWith(`${name}=`));
    if (from !== undefined) return word.slice(from.length + 1);
    if (!word.startsWith("-")) return word;
    if (valueOptions.has(word)) i += 1;
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
 * Whether a server is started from a package or an image without a pinned version. A server with no package or image,
 * one given a local path, and one not started by a runner aren't.
 */
function runsUnpinned(entry: unknown): boolean {
  if (!isObject(entry) || typeof entry.command !== "string") return false;
  // Claude Code reads an entry with a `type` other than stdio as a remote server, whatever else it holds.
  if (typeof entry.type === "string" && entry.type !== "stdio") return false;
  const words = commandLine(entry.command, entry.args);
  for (const { runners, target, pinned } of RUNNER_KINDS) {
    const rest = runners
      .map((runner) => argsAfterRunner(words, runner))
      .find((args) => args !== undefined);
    if (rest === undefined) continue;
    const started = target(rest);
    return started !== undefined && !LOCAL_PATH.test(started) && !pinned(started);
  }
  return false;
}

/** A server's key as a summary shows it: cut to `SUMMARY_KEY_MAX` characters. */
const summaryKey = (key: string) =>
  key.length > SUMMARY_KEY_MAX ? `${key.slice(0, SUMMARY_KEY_MAX - 1)}…` : key;

/**
 * What one file's MCP servers come to: none, or one Observation for all its unpinned servers, as a file's secrets
 * share one. Its line is the first unpinned server's key; its summary counts them, names up to three by key and ends
 * with the Pack's fix.
 */
export function mcpServerObservations(asset: Asset, { path, text: raw }: RepoFile): Observation[] {
  if (!MCP_FILE.test(path)) return [];
  const read = readJsonObject(raw);
  if (read === undefined || !isObject(read.config.mcpServers)) return [];
  const servers = Object.entries(read.config.mcpServers).flatMap(([key, entry]) =>
    runsUnpinned(entry) ? [key] : [],
  );
  const [first] = servers;
  if (first === undefined) return [];
  const line = valueLines(read.text, 2).get(JSON.stringify(["mcpServers", first])) ?? 1;
  const rule = packRule(MCP_SERVER_UNPINNED);
  const count = servers.length;
  const named = servers.slice(0, SUMMARY_KEYS_MAX).map(summaryKey).join(", ");
  const more = count > SUMMARY_KEYS_MAX ? ` and ${count - SUMMARY_KEYS_MAX} more` : "";
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
