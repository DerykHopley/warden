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
import { summaryNames } from "./summary.ts";

/** A project's MCP config: `.mcp.json` in any folder. */
const MCP_FILE = /(?:^|\/)\.mcp\.json$/;

/** Whether `path` is a project's MCP config, a `.mcp.json` in any folder. */
export const isMcpConfigPath = (path: string): boolean => MCP_FILE.test(path);

/** The package registries a Fix PR can pin a server's package from. */
export type PackageRegistryName = "npm" | "pypi";
/** Where a runner's packages come from: a package registry, or a container image's. */
type PackageSource = PackageRegistryName | "container";

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
 * The options `npx` and `npm exec` (and `npm`'s own, before `exec`) give the next word as their value: each npm config
 * option whose type isn't, and doesn't include, Boolean (npm 12's `@npmcli/config` definitions, as npx's own
 * `npx-cli.js` reads them; npm 10 and 11 add no value option missing here), its shorthands for one (`-C` is
 * `--prefix`), and npx's `-p`. npm reads any other option as a switch: one it doesn't know, a `--no-<option>`, a
 * cluster (`-yq`).
 */
const NPM_VALUE_OPTIONS = new Set([
  ...[
    ...["_auth", "access", "allow-directory", "allow-file", "allow-git", "allow-remote"],
    ...["allow-scripts", "also", "audit-level", "auth-type", "before", "ca", "cache", "cache-max"],
    ...["cache-min", "cafile", "call", "cert", "cidr", "cpu", "depth", "diff", "diff-dst-prefix"],
    ...["diff-src-prefix", "diff-unified", "edit-dir", "editor", "expect-result-count", "expires"],
    ...["extension-file", "fetch-retries", "fetch-retry-factor", "fetch-retry-maxtimeout"],
    ...["fetch-retry-mintimeout", "fetch-timeout", "git", "global-ignore-file", "globalconfig"],
    ...["heading", "https-proxy", "include", "init-author-email", "init-author-name"],
    ...["init-author-url", "init-license", "init-module", "init-type", "init-version"],
    ...["init.author.email", "init.author.name", "init.author.url", "init.license", "init.module"],
    ...["init.version", "install-strategy", "key", "libc", "local-address", "location"],
    ...["lockfile-version", "loglevel", "logs-dir", "logs-max", "maxsockets", "message"],
    ...[
      "min-release-age",
      "min-release-age-exclude",
      "name",
      "node-gyp",
      "node-options",
      "noproxy",
    ],
    ...["omit", "only", "orgs", "orgs-permission", "os", "otp", "pack-destination", "package"],
    ...["packages", "packages-and-scopes-permission", "password", "patches-dir", "prefix", "preid"],
    ...["provenance-file", "proxy", "registry", "replace-registry-host", "save-prefix"],
    ...["sbom-format", "sbom-type", "scope", "scopes", "script-shell", "searchexclude"],
    ...["searchlimit", "searchopts", "searchstaleness", "shell", "tag", "tag-version-prefix", "to"],
    ...["token-description", "umask", "user-agent", "userconfig", "viewer", "which", "workspace"],
    // shorthands
    ...["reg", "enjoy-by"],
  ].map((name) => `--${name}`),
  ...["-c", "-C", "-L", "-m", "-w", "-p"],
]);

/** `bunx`'s switches (bun's `bunx` docs). */
const BUNX_SWITCHES = new Set([
  ...["--bun", "--no-install", "--use-system-ca", "--use-openssl-ca", "--use-bundled-ca"],
  ...["--trust", "--verbose", "--silent"],
]);

/**
 * The options `pnpm dlx` (and `pnpm`'s own, before `dlx`) gives the next word as its value: those whose type doesn't
 * include Boolean in pnpm 10's global, `add` and `install` option types (the ones its first pass reads to find `dlx`)
 * and in `dlx`'s own, with their shorthands (`-C` is `--dir`, `-F` is `--filter`). pnpm reads any other option as a
 * switch, one it doesn't know and every `--no-<option>` included.
 */
const PNPM_VALUE_OPTIONS = new Set([
  ...[
    ...["allow-build", "cache-dir", "changed-files-ignore-pattern", "child-concurrency", "cpu"],
    ...["dir", "fetch-retries", "fetch-retry-factor", "fetch-retry-maxtimeout"],
    ...["fetch-retry-mintimeout", "fetch-timeout", "filter", "filter-prod", "global-bin-dir"],
    ...["global-dir", "global-pnpmfile", "hoist-pattern", "https-proxy", "libc", "lockfile-dir"],
    ...["lockfile-directory", "loglevel", "merge-git-branch-lockfiles-branch-pattern"],
    ...["modules-dir", "network-concurrency", "node-linker", "noproxy", "npm-path", "only", "os"],
    ...["package", "package-import-method", "pnpmfile", "prefix", "proxy", "public-hoist-pattern"],
    ...["registry", "reporter", "save-catalog-name", "save-prefix", "scripts-prepend-node-path"],
    ...["store-dir", "test-pattern", "trust-policy", "trust-policy-exclude"],
    ...["trust-policy-ignore-after", "use-node-version", "virtual-store-dir", "workspace-packages"],
  ].map((name) => `--${name}`),
  ...["-C", "-F"],
]);

/** `yarn dlx`'s switches (Yarn's `dlx` docs), `--no-quiet` as clipanion reads a Boolean option's negation. */
const YARN_SWITCHES = new Set(["-q", "--quiet", "--no-quiet"]);

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

/** An npm exact version, `1.2.3` or `1.2.3-beta.1+build`: no tag and no range. */
const NPM_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
/** A Python exact version, `0.4.1`, pre-releases included. */
const PYTHON_VERSION = String.raw`\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?`;
/** A package at an exact version, `name@1.2.3` or `@scope/name@1.2.3-beta.1`: no tag and no range. */
const NPM_PINNED = new RegExp(String.raw`^(?:@[^/@]+\/)?[^@]+@${NPM_VERSION}$`);
/** A Python package at an exact version, `name==0.4.1` or `name@0.4.1`, pre-releases included. */
const PYTHON_PINNED = new RegExp(`(?:==|@)${PYTHON_VERSION}$`);

/** What the scanner reads as pinned for each registry's runners: a version on its own, and a package word. */
const PINNED: Record<PackageRegistryName, { version: RegExp; word: RegExp }> = {
  npm: { version: new RegExp(`^${NPM_VERSION}$`), word: NPM_PINNED },
  pypi: { version: new RegExp(`^${PYTHON_VERSION}$`), word: PYTHON_PINNED },
};

/**
 * Whether a version a registry answers has the shape the scanner reads as pinned (`NPM_PINNED`'s or
 * `PYTHON_PINNED`'s version part), so a package written at it clears the Rule and no other text gets into a repo.
 */
export const isPinnedVersion = (registry: PackageRegistryName, version: string): boolean =>
  PINNED[registry].version.test(version);

/** Whether a package word is one the scanner reads as pinned, for an npm or a Python runner. */
export const isPinnedPackage = (registry: PackageRegistryName, word: string): boolean =>
  PINNED[registry].word.test(word);
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
/** A local path (`./server`, `/opt/mcp`, `~/mcp`, `C:\mcp`): a local server, not a package. */
const LOCAL_PATH = /^(?:[.~/\\]|[A-Za-z]:[\\/])/;

/** How a command reads its options. */
type Options = {
  /** Whether `option`, written without `=`, takes `next`, the word after it, as its value. */
  takesValue(option: string, next: string | undefined): boolean;
  /** Whether a short-option cluster (`-it`) is read letter by letter, as docker and podman read it. */
  clusters: boolean;
};

/**
 * A command whose value options are listed: each takes the next word, whatever it starts with, and any other option is
 * a switch. uv and pipx refuse an option they don't know; npm and pnpm read it as a switch.
 */
const valueOptions = (values: ReadonlySet<string>): Options => ({
  takesValue: (option) => values.has(option),
  clusters: false,
});

/**
 * A command whose switches are listed: any other option takes the next word as its value, whatever it starts with.
 * docker, podman and yarn refuse an option they don't know, so an option a working config gives them that isn't
 * listed is one that takes a value.
 */
function switchOptions(switches: ReadonlySet<string>, clusters = false): Options {
  return {
    takesValue: (option, next) => !switches.has(option) && next !== undefined,
    clusters,
  };
}

const NPM = valueOptions(NPM_VALUE_OPTIONS);
const PYTHON = valueOptions(PYTHON_VALUE_OPTIONS);
const CONTAINER = switchOptions(CONTAINER_SWITCHES, true);

/**
 * A runner's command and subcommand words (`["pnpm", "dlx"]`), with the command's own options (`globals`, else
 * `options`) allowed between them, and how it reads its options before the package or image.
 */
type Runner = { words: readonly string[]; options: Options; globals?: Options };

/** One kind of runner: the runners that start it, the options that name what it starts, and when that is pinned. */
type RunnerKind = {
  /** Where its packages come from: npm, PyPI, or a container registry. */
  source: PackageSource;
  runners: readonly Runner[];
  /** Options whose value is the package (`-p x`, `--package=x`), given before it. */
  fromOptions: readonly string[];
  pinned(target: string): boolean;
};

const RUNNER_KINDS: readonly RunnerKind[] = [
  {
    source: "npm",
    runners: [
      { words: ["npx"], options: NPM },
      { words: ["bunx"], options: switchOptions(BUNX_SWITCHES) },
      { words: ["pnpm", "dlx"], options: valueOptions(PNPM_VALUE_OPTIONS) },
      { words: ["yarn", "dlx"], options: switchOptions(YARN_SWITCHES) },
      { words: ["npm", "exec"], options: NPM },
    ],
    fromOptions: ["-p", "--package"],
    pinned: (pkg) => isPinnedPackage("npm", pkg),
  },
  {
    source: "pypi",
    runners: [
      { words: ["uvx"], options: PYTHON },
      { words: ["uv", "tool", "run"], options: PYTHON },
      { words: ["pipx", "run"], options: PYTHON },
    ],
    fromOptions: ["--from", "--spec"],
    pinned: (pkg) => isPinnedPackage("pypi", pkg),
  },
  {
    source: "container",
    runners: (
      [
        ["docker", DOCKER_SWITCHES],
        ["podman", PODMAN_SWITCHES],
      ] as const
    ).flatMap(([command, globals]) =>
      [["run"], ["container", "run"]].map((subcommand) => ({
        words: [command, ...subcommand],
        options: CONTAINER,
        globals: switchOptions(globals, true),
      })),
    ),
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
 * Where a command-line word sits in a server's entry: an `args` entry by its index, or a span of `command`'s text
 * (from `start`, up to `end`).
 */
export type WordAt =
  { field: "args"; index: number } | { field: "command"; start: number; end: number };

/** One word of a server's command line, and where it sits. */
type Word = { text: string; at: WordAt };

/**
 * A server's command line as words: its `command`, then its string `args`, read after a leading `cmd /c`. The command
 * is one word when the whole of it names a runner or `cmd`, as a path with a space does (`C:\Program
 * Files\nodejs\npx.cmd`); otherwise it is split on white space (`npx -y some-mcp-server`).
 */
function commandLine(command: string, args: unknown): Word[] {
  const whole = command.trim();
  const start = command.indexOf(whole);
  const words: Word[] = [
    ...(RUNNER_COMMANDS.has(commandName(whole)) || isCmd(whole)
      ? [{ text: whole, at: { field: "command", start, end: start + whole.length } } as const]
      : [...command.matchAll(/\S+/g)].map(({ 0: text, index }) => ({
          text,
          at: { field: "command", start: index, end: index + text.length } as const,
        }))),
    ...(Array.isArray(args) ? args : []).flatMap((arg: unknown, index) =>
      typeof arg === "string" ? [{ text: arg, at: { field: "args", index } as const }] : [],
    ),
  ];
  return isCmd(words[0]?.text) && /^\/c$/i.test(words[1]?.text ?? "") ? words.slice(2) : words;
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
 * Where the words after `runner` start when `words` start with it: its command by `commandName`, then each subcommand
 * word exactly, with the command's own options allowed before each.
 */
function argsAfterRunner(words: readonly string[], runner: Runner): number | undefined {
  const [command, ...subcommand] = runner.words;
  if (words[0] === undefined || commandName(words[0]) !== command) return undefined;
  let at = 1;
  for (const word of subcommand) {
    at = afterOptions(words, at, runner.globals ?? runner.options);
    if (words[at] !== word) return undefined;
    at += 1;
  }
  return at;
}

/**
 * What a runner starts, as the index of the word in `rest` that holds it and the text before it there: the value of
 * one of `fromOptions` (`-p x`, `--package=x`, where `--package=` comes before it) given before the first argument,
 * else that first argument: the word after `--`, or a word that isn't an option or an option's value. What comes
 * after it is the server's own. `positional` is whether it is that first argument rather than an option's value.
 */
function runnerTarget(
  rest: readonly string[],
  fromOptions: readonly string[],
  options: Options,
): { index: number; prefix: string; positional: boolean } | undefined {
  for (let i = 0; i < rest.length; i += optionWidth(rest, i, options)) {
    const word = rest[i]!;
    if (word === "--" || fromOptions.includes(word)) {
      return i + 1 < rest.length
        ? { index: i + 1, prefix: "", positional: word === "--" }
        : undefined;
    }
    const from = fromOptions.find((name) => name.startsWith("--") && word.startsWith(`${name}=`));
    if (from !== undefined) return { index: i, prefix: `${from}=`, positional: false };
    if (!word.startsWith("-")) return { index: i, prefix: "", positional: true };
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

/** What a server's runner starts, as the scanner reads it, and where in the entry that is written. */
export type ServerStart = {
  /** Where the runner's packages come from. */
  source: PackageSource;
  /** The runner's words, `["uv", "tool", "run"]`. */
  runner: readonly string[];
  /** The package or image, as written: `pkg`, `pkg@latest`, `name[extra]>=1`, `ghcr.io/org/image`. */
  target: string;
  /** The word holding it, which is `prefix` then `target`. */
  at: WordAt;
  /** The text before the target in its word: `--from=` in `--from=pkg`, else empty. */
  prefix: string;
  /** Whether the target is the runner's first argument, not an option's value (`--from pkg`). */
  positional: boolean;
  /** Whether the scanner reads it as pinned. */
  pinned: boolean;
};

/**
 * What a server is started from, when a runner starts a package or an image: undefined for a remote server, one with
 * no package or image, one given a local path, and one not started by a runner.
 */
export function serverStart(entry: unknown): ServerStart | undefined {
  if (!isObject(entry) || typeof entry.command !== "string") return undefined;
  // Claude Code reads an entry with a `type` other than stdio as a remote server, whatever else it holds.
  if (typeof entry.type === "string" && entry.type !== "stdio") return undefined;
  const words = commandLine(entry.command, entry.args);
  const texts = words.map(({ text }) => text);
  for (const { source, runners, fromOptions, pinned } of RUNNER_KINDS) {
    for (const runner of runners) {
      const after = argsAfterRunner(texts, runner);
      if (after === undefined) continue;
      const found = runnerTarget(texts.slice(after), fromOptions, runner.options);
      if (found === undefined) return undefined;
      const word = words[after + found.index]!;
      const target = word.text.slice(found.prefix.length);
      if (LOCAL_PATH.test(target)) return undefined;
      return {
        source,
        runner: runner.words,
        target,
        at: word.at,
        prefix: found.prefix,
        positional: found.positional,
        pinned: pinned(target),
      };
    }
  }
  return undefined;
}

/** Whether a server is started from a package or an image without a pinned version. */
const runsUnpinned = (entry: unknown): boolean => serverStart(entry)?.pinned === false;

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
  const where = count === 1 ? `on line ${line}` : `first on line ${line}`;
  return [
    {
      asset,
      rule_id: rule.ruleId,
      location: { kind: "file", path, line },
      severity: rule.severity,
      title: rule.title,
      evidence: {
        summary: `${count} ${count === 1 ? "MCP server" : "MCP servers"} without a pinned version (${summaryNames(servers)}) in ${path}, ${where}. To fix: ${rule.fix}`,
      },
    },
  ];
}
