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

/**
 * npm's switches, as `npx` and `npm exec` read them: npm's Boolean config options (npm 12's `@npmcli/config`
 * definitions), the shorthands that stand for a whole option, and the ones `npx` adds. `--no-<switch>` is one too.
 */
const NPM_SWITCHES = new Set([
  ...[
    "all",
    "allow-same-version",
    "allow-scripts-pending",
    "allow-scripts-pin",
    "allow-unused-patches",
    "audit",
    "bin-links",
    "browser",
    "bypass-2fa",
    "color",
    "commit-hooks",
    "dangerously-allow-all-scripts",
    "description",
    "dev",
    "diff-ignore-all-space",
    "diff-name-only",
    "diff-no-prefix",
    "diff-text",
    "dry-run",
    "engine-strict",
    "expect-results",
    "force",
    "foreground-scripts",
    "format-package-lock",
    "fund",
    "git-tag-version",
    "global",
    "global-style",
    "if-present",
    "ignore-existing",
    "ignore-extension",
    "ignore-patch-failures",
    "ignore-scripts",
    "include-attestations",
    "include-staged",
    "include-workspace-root",
    "init-private",
    "install-links",
    "json",
    "keep-edit-dir",
    "legacy-bundling",
    "legacy-peer-deps",
    "link",
    "long",
    "offline",
    "omit-lockfile-registry-resolved",
    "optional",
    "package-lock",
    "package-lock-only",
    "packages-all",
    "parseable",
    "prefer-dedupe",
    "prefer-offline",
    "prefer-online",
    "production",
    "progress",
    "provenance",
    "read-only",
    "rebuild-bundle",
    "save",
    "save-bundle",
    "save-dev",
    "save-exact",
    "save-optional",
    "save-peer",
    "save-prod",
    "sign-git-commit",
    "sign-git-tag",
    "strict-allow-scripts",
    "strict-npmrc",
    "strict-peer-deps",
    "strict-ssl",
    "timing",
    "unicode",
    "update-notifier",
    "usage",
    "version",
    "versions",
    "workspaces",
    "workspaces-update",
    "yes",
    // Long shorthands for a whole option.
    "quiet",
    "silent",
    "verbose",
    "desc",
    "help",
    "porcelain",
    "readonly",
    "iwr",
    "ws",
    "local",
    "no-install",
  ].map((name) => `--${name}`),
  ...["-d", "-dd", "-ddd", "-q", "-s", "-a", "-f", "-g", "-l", "-S", "-B", "-D", "-E", "-O", "-P"],
  ...["-?", "-H", "-h", "-v", "-y"],
]);

const isNpmSwitch = (option: string) =>
  NPM_SWITCHES.has(option) || NPM_SWITCHES.has(option.replace(/^--no-/, "--"));

/** `bunx`'s switches (bun's `bunx` docs). */
const BUNX_SWITCHES = new Set([
  ...["--bun", "--no-install", "--use-system-ca", "--use-openssl-ca", "--use-bundled-ca"],
  ...["--trust", "--verbose", "--silent"],
]);

/** pnpm's switches, before `dlx` and after it (pnpm 10's `pnpm dlx --help` and CLI docs). */
const PNPM_SWITCHES = new Set([
  "-c",
  "--shell-mode",
  "-s",
  "--silent",
  "-r",
  "--recursive",
  "-w",
  "--workspace-root",
]);

/** `yarn dlx`'s switches (Yarn's `dlx` docs). */
const YARN_SWITCHES = new Set(["-q", "--quiet"]);

/** `docker run`'s and `podman run`'s switches, their Boolean options (docker 29's and podman 6's `run --help`). */
const CONTAINER_SWITCHES = new Set([
  ...[
    "-d",
    "--detach",
    "-i",
    "--interactive",
    "-t",
    "--tty",
    "-P",
    "--publish-all",
    "-q",
    "--quiet",
  ],
  ...["--rm", "--init", "--privileged", "--read-only", "--help", "--no-healthcheck"],
  ...["--oom-kill-disable", "--sig-proxy", "--use-api-socket", "--disable-content-trust"],
  // podman's own
  ...["--env-host", "--http-proxy", "--no-hostname", "--no-hosts", "--passwd", "--read-only-tmpfs"],
  ...["--replace", "--rmi", "--rootfs", "--tls-verify", "--unsetenv-all"],
]);

/** `docker`'s own switches, before its subcommand words. */
const DOCKER_SWITCHES = new Set([
  "-D",
  "--debug",
  "--tls",
  "--tlsverify",
  "-v",
  "--version",
  "--help",
]);
/** `podman`'s own switches, before its subcommand words. */
const PODMAN_SWITCHES = new Set([
  "-r",
  "--remote",
  "--syslog",
  "--transient-store",
  "-v",
  "--version",
  "--help",
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

/** How a command reads its options. */
type Options = {
  /** Whether `option`, written without `=`, takes `next`, the word after it, as its value. */
  takesValue(option: string, next: string | undefined): boolean;
  /** Whether a short-option cluster (`-it`) is read letter by letter, as docker and podman read it. */
  clusters: boolean;
};

/** A command that refuses an option it doesn't know, so the ones that take a value can be listed (uv, pipx). */
const valueOptions = (values: ReadonlySet<string>): Options => ({
  takesValue: (option) => values.has(option),
  clusters: false,
});

/**
 * A command whose switches are listed: any other option takes the next word as its value, unless that word starts
 * with `-`, as npx reads an option it doesn't know. An option added later, or one never listed, is read as taking a
 * value, as most of these commands' options do.
 */
const switchOptions = (isSwitch: (option: string) => boolean, clusters = false): Options => ({
  takesValue: (option, next) => !isSwitch(option) && next !== undefined && !next.startsWith("-"),
  clusters,
});

const switches = (names: ReadonlySet<string>) => (option: string) => names.has(option);

const NPM = switchOptions(isNpmSwitch);
const PYTHON = valueOptions(PYTHON_VALUE_OPTIONS);
const CONTAINER = switchOptions(switches(CONTAINER_SWITCHES), true);

/**
 * A runner's command and subcommand words (`["pnpm", "dlx"]`), with the command's own options (`globals`, else
 * `options`) allowed between them, and how it reads its options before the package or image.
 */
type Runner = { words: readonly string[]; options: Options; globals?: Options };

/** One kind of runner: the runners that start it, the options that name what it starts, and when that is pinned. */
type RunnerKind = {
  runners: readonly Runner[];
  /** Options whose value is the package (`-p x`, `--package=x`), given before it. */
  fromOptions: readonly string[];
  pinned(target: string): boolean;
};

const RUNNER_KINDS: readonly RunnerKind[] = [
  {
    runners: [
      { words: ["npx"], options: NPM },
      { words: ["bunx"], options: switchOptions(switches(BUNX_SWITCHES)) },
      { words: ["pnpm", "dlx"], options: switchOptions(switches(PNPM_SWITCHES)) },
      { words: ["yarn", "dlx"], options: switchOptions(switches(YARN_SWITCHES)) },
      { words: ["npm", "exec"], options: NPM },
    ],
    fromOptions: ["-p", "--package"],
    pinned: (pkg) => NPM_PINNED.test(pkg),
  },
  {
    runners: [
      { words: ["uvx"], options: PYTHON },
      { words: ["uv", "tool", "run"], options: PYTHON },
      { words: ["pipx", "run"], options: PYTHON },
    ],
    fromOptions: ["--from", "--spec"],
    pinned: (pkg) => PYTHON_PINNED.test(pkg),
  },
  {
    runners: ["run", "container run"].flatMap((subcommand) => [
      {
        words: ["docker", ...subcommand.split(" ")],
        options: CONTAINER,
        globals: switchOptions(switches(DOCKER_SWITCHES), true),
      },
      {
        words: ["podman", ...subcommand.split(" ")],
        options: CONTAINER,
        globals: switchOptions(switches(PODMAN_SWITCHES), true),
      },
    ]),
    fromOptions: [],
    pinned: imagePinned,
  },
];

/** The commands that start a runner, by `commandName`. */
const RUNNER_COMMANDS = new Set(
  RUNNER_KINDS.flatMap(({ runners }) => runners.map(({ words: [first] }) => first)),
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

/**
 * How many words the option at `words[i]` takes: 2 when its value is the next word, else 1. `--opt=value` is one word.
 * A short-option cluster (`-ie`) is read letter by letter, when `options` read them: switches while the letters are
 * switches; a letter that takes a value takes the rest of the word, or the next word when it's the last letter.
 */
function optionWidth(words: readonly string[], i: number, options: Options): 1 | 2 {
  const word = words[i]!;
  if (word.includes("=")) return 1;
  if (options.clusters && /^-[^-]{2,}$/.test(word)) {
    for (let k = 1; k < word.length - 1; k += 1) {
      if (options.takesValue(`-${word[k]}`, word.slice(k + 1))) return 1;
    }
    return options.takesValue(`-${word.at(-1)}`, words[i + 1]) ? 2 : 1;
  }
  return options.takesValue(word, words[i + 1]) ? 2 : 1;
}

/** The index of the first word from `i` on that isn't an option or an option's value, `--` included. */
function afterOptions(words: readonly string[], i: number, options: Options): number {
  let at = i;
  while (words[at]?.startsWith("-") && words[at] !== "--") at += optionWidth(words, at, options);
  return at;
}

/**
 * The words after `runner` when `words` start with it: its command by `commandName`, then each subcommand word
 * exactly, with the command's own options allowed before each.
 */
function argsAfterRunner(words: readonly string[], runner: Runner): string[] | undefined {
  const [command, ...subcommand] = runner.words;
  if (words[0] === undefined || commandName(words[0]) !== command) return undefined;
  let at = 1;
  for (const word of subcommand) {
    at = afterOptions(words, at, runner.globals ?? runner.options);
    if (words[at] !== word) return undefined;
    at += 1;
  }
  return words.slice(at);
}

/**
 * What a runner starts: the value of one of `fromOptions` (`-p x`, `--package=x`) given before the first argument, else
 * that first argument: the word after `--`, or a word that isn't an option or an option's value. What comes after it
 * is the server's own.
 */
function runnerTarget(
  rest: readonly string[],
  fromOptions: readonly string[],
  options: Options,
): string | undefined {
  for (let i = 0; i < rest.length; i += optionWidth(rest, i, options)) {
    const word = rest[i]!;
    if (word === "--" || fromOptions.includes(word)) return rest[i + 1];
    const from = fromOptions.find((name) => name.startsWith("--") && word.startsWith(`${name}=`));
    if (from !== undefined) return word.slice(from.length + 1);
    if (!word.startsWith("-")) return word;
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
  for (const { runners, fromOptions, pinned } of RUNNER_KINDS) {
    for (const runner of runners) {
      const rest = argsAfterRunner(words, runner);
      if (rest === undefined) continue;
      const started = runnerTarget(rest, fromOptions, runner.options);
      return started !== undefined && !LOCAL_PATH.test(started) && !pinned(started);
    }
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
