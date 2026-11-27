// Guard's MCP server Rule (Guard spec, stories 3 and 4): `mcpServerObservations(asset, file)` reads a `.mcp.json` as
// Claude Code does and answers one Observation for a file whose servers start a package or an image without a pinned
// version, at the first such server's key. Remote servers and local commands are never flagged.
import { type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { AWS_KEY, GITHUB_TOKEN } from "../../../test/secret-fixtures.ts";
import { lineWith } from "../../../test/text-lines.ts";
import { packRule } from "./default-pack.ts";
import { mcpServerObservations, serverStart } from "./mcp-servers.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const MCP = "guard/mcp-server-unpinned";

/** A digest's 64 hex characters. */
const DIGEST = "0123456789abcdef".repeat(4);

/** A remote server: never flagged, and first in each file so the flagged server's key isn't on a fixed line. */
const REMOTE = { type: "http", url: "https://example.com/mcp" };

/** A `.mcp.json`'s text, pretty-printed as `claude mcp add --scope project` writes it. */
const mcpJson = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;

const observe = (path: string, text: string) => mcpServerObservations(repo, { path, text });

/** A server started as `command` with `args`. */
const server = (command: string, args?: string[]) =>
  args === undefined ? { command } : { command, args };

/** A row for a server written as `line`: its command, then its args, split on spaces. */
const asWritten = (line: string): [string, string, string[]] => {
  const [command = "", ...args] = line.split(" ");
  return [line, command, args];
};

/** A "gives nothing" row for a server written as `line`. */
const entryWritten = (line: string): [string, Record<string, unknown>] => {
  const [, command, args] = asWritten(line);
  return [line, server(command, args)];
};

describe("guard/mcp-server-unpinned", () => {
  it.each([
    ["npx -y some-mcp-server", "npx", ["-y", "some-mcp-server"]],
    ["npx some-mcp-server@latest", "npx", ["some-mcp-server@latest"]],
    ["npx @scope/server@^1.2.0", "npx", ["@scope/server@^1.2.0"]],
    ["npx @scope/server", "npx", ["@scope/server"]],
    ["npx some-mcp-server@1", "npx", ["some-mcp-server@1"]],
    ["npx some-mcp-server@1.x", "npx", ["some-mcp-server@1.x"]],
    ["npx some-mcp-server@next", "npx", ["some-mcp-server@next"]],
    ["npx --package=some-mcp-server some-bin", "npx", ["--package=some-mcp-server", "some-bin"]],
    ["npx -p some-mcp-server some-bin@1.2.3", "npx", ["-p", "some-mcp-server", "some-bin@1.2.3"]],
    ["bunx some-mcp-server", "bunx", ["some-mcp-server"]],
    ["pnpm dlx some-mcp-server", "pnpm", ["dlx", "some-mcp-server"]],
    ["yarn dlx some-mcp-server@latest", "yarn", ["dlx", "some-mcp-server@latest"]],
    ["npm exec some-mcp-server", "npm", ["exec", "some-mcp-server"]],
    ["uvx some-server", "uvx", ["some-server"]],
    ["uvx some-server@latest", "uvx", ["some-server@latest"]],
    ["uvx --from some-server some-bin==0.4.1", "uvx", ["--from", "some-server", "some-bin==0.4.1"]],
    ["uv tool run some-server", "uv", ["tool", "run", "some-server"]],
    ["pipx run some-server", "pipx", ["run", "some-server"]],
    [
      "docker run -i --rm -e TOKEN ghcr.io/x/server",
      "docker",
      ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/x/server"],
    ],
    ["docker run ghcr.io/x/server:latest", "docker", ["run", "ghcr.io/x/server:latest"]],
    ["docker run localhost:5000/server", "docker", ["run", "localhost:5000/server"]],
    [
      "docker run -v /data:/data:1 --name mcp server",
      "docker",
      ["run", "-v", "/data:/data:1", "--name", "mcp", "server"],
    ],
    ["podman run ghcr.io/x/server", "podman", ["run", "ghcr.io/x/server"]],
    // A runner is known by its command's last path segment, without a Windows `.cmd` or `.exe` ending.
    [
      "/opt/homebrew/bin/npx -y some-mcp-server",
      "/opt/homebrew/bin/npx",
      ["-y", "some-mcp-server"],
    ],
    ["npx.cmd -y some-mcp-server", "npx.cmd", ["-y", "some-mcp-server"]],
    ["npx.CMD -y some-mcp-server", "npx.CMD", ["-y", "some-mcp-server"]],
    [
      "C:\\Program Files\\nodejs\\npx.cmd -y some-mcp-server",
      "C:\\Program Files\\nodejs\\npx.cmd",
      ["-y", "some-mcp-server"],
    ],
    ["uvx.exe some-server", "uvx.exe", ["some-server"]],
    // A runner's command name is matched in any case, as Windows and macOS find it (#266).
    ["NPX some-mcp-server", "NPX", ["some-mcp-server"]],
    ["Uvx some-server", "Uvx", ["some-server"]],
    ["PNPM dlx some-mcp-server", "PNPM", ["dlx", "some-mcp-server"]],
    ["Docker run ghcr.io/x/server", "Docker", ["run", "ghcr.io/x/server"]],
    [
      "C:\\Program Files\\nodejs\\NPX.CMD -y some-mcp-server",
      "C:\\Program Files\\nodejs\\NPX.CMD",
      ["-y", "some-mcp-server"],
    ],
    [
      "C:\\Windows\\System32\\cmd.exe /c npx -y some-mcp-server",
      "C:\\Windows\\System32\\cmd.exe",
      ["/c", "npx", "-y", "some-mcp-server"],
    ],
    // A command string whose last word ends in a runner's name is still split into words (#317).
    ["npx -y @acme/uvx", "npx -y @acme/uvx", []],
    // A Python runner's option values aren't the package.
    [
      "uvx --with httpx==0.27.0 mcp-server-fetch",
      "uvx",
      ["--with", "httpx==0.27.0", "mcp-server-fetch"],
    ],
    // A container runtime's option values aren't the image.
    [
      "docker run -i --rm --add-host host.docker.internal:host-gateway mcp/github",
      "docker",
      ["run", "-i", "--rm", "--add-host", "host.docker.internal:host-gateway", "mcp/github"],
    ],
    // npm's and pnpm's value options take the next word, whatever it starts with; any other option is a switch, as
    // npm and pnpm read an option they don't know.
    ...[
      "npx --prefix /opt/x pkg",
      "npx --cache ~/.npm pkg",
      "npx --userconfig ./.npmrc pkg",
      "npx -C /opt/x pkg",
      "npx --registry https://registry.example.com pkg",
      "npx --cache -x pkg",
      "npx --registry -x pkg",
      "npm --prefix -x exec pkg",
      // A dash-led value that is itself a listed value option: a value option missing from its list would take the
      // package instead.
      "npx --cache -C pkg",
      "npx --registry -w pkg",
      "npm --prefix -C exec pkg",
      "pnpm --dir -F dlx pkg",
      "npx --made-up-option evil pkg@1.2.3",
      "npm exec --made-up-option evil -- pkg@1.2.3",
      "pnpm -C x dlx pkg",
      "pnpm --filter x dlx pkg",
      "pnpm --dir -x dlx pkg",
      // bunx and yarn dlx read an option they don't list as a switch as taking the next word.
      "bunx --made-up-option ./x pkg",
      "yarn dlx --made-up-option ./x pkg",
      "npm exec --prefix ./tools -- pkg",
      // Its switches, and any option it doesn't list, take no value; `--` ends the options.
      "npx --yes pkg",
      "npx -q pkg",
      "npx --prefer-offline pkg",
      "npx --no-color pkg",
      "bunx --bun pkg",
      "npx --made-up-option --yes pkg",
      "npx -- pkg",
      // npm's shorthands (`-ws`, `-iwr`) and its single-letter ones written together (`-yq`) are switches.
      "npx -ws pkg",
      "npx -iwr pkg",
      "npx -yq pkg",
      // pnpm's on/off options and every `--no-<option>` are switches, before `dlx` and after it; yarn's too.
      "pnpm --no-color dlx pkg",
      "pnpm --stream dlx pkg",
      "pnpm dlx --prefer-offline pkg",
      "yarn dlx --no-quiet pkg",
      // A container runner does the same, and reads a short-option cluster letter by letter.
      "docker run --cidfile /tmp/c mcp/github",
      "podman run --made-up-option x mcp/github",
      "docker run -it mcp/github",
      // Its value options take the next word, whatever it starts with, the last letter of a cluster's too.
      "docker run -e -x mcp/github",
      "podman run -e -x mcp/github",
      "docker run -ie -x mcp/github",
      "docker --log-level -x run mcp/github",
      // A command's own options before its subcommand word don't hide the runner.
      "pnpm --dir x dlx pkg",
      "npm --prefix ./x exec pkg",
      "uv --directory /x tool run pkg",
      "docker --log-level debug run mcp/github",
      "docker -D run mcp/github",
      "docker container run mcp/github",
      "podman container run mcp/github",
    ].map(asWritten),
  ])("reports %s at .mcp.json and the server key's line", (_name, command, args) => {
    const text = mcpJson({ remote: REMOTE, unpinned: server(command, args) });

    const observations = observe(".mcp.json", text);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      asset: repo,
      rule_id: MCP,
      location: { kind: "file", path: ".mcp.json", line: lineWith(text, '"unpinned"') },
    });
  });

  it.each([
    ["npx -y some-mcp-server@1.2.3", server("npx", ["-y", "some-mcp-server@1.2.3"])],
    ["npx @scope/server@1.2.3-beta.1", server("npx", ["@scope/server@1.2.3-beta.1"])],
    [
      "npx -p some-mcp-server@1.2.3 some-bin",
      server("npx", ["-p", "some-mcp-server@1.2.3", "some-bin"]),
    ],
    [
      "npx --package=some-mcp-server@1.2.3 some-bin",
      server("npx", ["--package=some-mcp-server@1.2.3", "some-bin"]),
    ],
    ["pnpm dlx some-mcp-server@1.2.3", server("pnpm", ["dlx", "some-mcp-server@1.2.3"])],
    ["uvx some-server==0.4.1", server("uvx", ["some-server==0.4.1"])],
    ["uvx some-server@0.4.1", server("uvx", ["some-server@0.4.1"])],
    [
      "uvx --from some-server==0.4.1 some-bin",
      server("uvx", ["--from", "some-server==0.4.1", "some-bin"]),
    ],
    [
      "pipx run --spec some-server==0.4.1 some-bin",
      server("pipx", ["run", "--spec", "some-server==0.4.1", "some-bin"]),
    ],
    [
      "docker run -i --rm -e TOKEN ghcr.io/x/server:1.4.0",
      server("docker", ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/x/server:1.4.0"]),
    ],
    [
      "an image with a digest",
      server("docker", ["run", "-i", `ghcr.io/x/server@sha256:${DIGEST}`]),
    ],
    [
      "an image on a registry with a port, tagged",
      server("podman", ["run", "localhost:5000/server:1.0"]),
    ],
    ["a remote server", { type: "http", url: "https://example.com/mcp" }],
    ["an SSE server", { type: "sse", url: "https://example.com/sse" }],
    ["node ./server.js", server("node", ["./server.js"])],
    ["a binary by path", server("./bin/mcp-server")],
    // A command string's words are one spaced path only when it starts as a path and no later word starts an option or
    // another path, so a script named after a runner isn't read as that runner.
    [
      "node /opt/tools/uvx server.js in one command string",
      server("node /opt/tools/uvx server.js"),
    ],
    [
      "/usr/bin/node /opt/tools/uvx server.js in one command string",
      server("/usr/bin/node /opt/tools/uvx server.js"),
    ],
    ["a runner with no package", server("npx", ["-y"])],
    ["docker run with no image", server("docker", ["run", "-i", "--rm"])],
    // `-p` / `--package` and `--from` / `--spec` after the package are the server's own args.
    ["npx -y mcp-proxy@2.1.0 -p 8080", server("npx", ["-y", "mcp-proxy@2.1.0", "-p", "8080"])],
    ["npx mcp-proxy@2.1.0 --package=x", server("npx", ["mcp-proxy@2.1.0", "--package=x"])],
    ["uvx some-server==0.4.1 --from x", server("uvx", ["some-server==0.4.1", "--from", "x"])],
    // A runner's option values aren't the package or the image.
    [
      "uvx --with httpx mcp-server-fetch==1.0.0",
      server("uvx", ["--with", "httpx", "mcp-server-fetch==1.0.0"]),
    ],
    ["uvx -p 3.12 some-server==0.4.1", server("uvx", ["-p", "3.12", "some-server==0.4.1"])],
    [
      "uvx --index-url https://example.com/simple some-server==0.4.1",
      server("uvx", ["--index-url", "https://example.com/simple", "some-server==0.4.1"]),
    ],
    [
      "uvx -c constraints.txt some-server==0.4.1",
      server("uvx", ["-c", "constraints.txt", "some-server==0.4.1"]),
    ],
    [
      "pipx run --python python3.12 some-server==0.4.1",
      server("pipx", ["run", "--python", "python3.12", "some-server==0.4.1"]),
    ],
    [
      "docker run -l a=b -h mcp -m 512m --cap-add NET_ADMIN --pull always mcp/github:1.0",
      server("docker", [
        ...["run", "-l", "a=b", "-h", "mcp", "-m", "512m", "--cap-add", "NET_ADMIN"],
        ...["--pull", "always", "mcp/github:1.0"],
      ]),
    ],
    // A package argument that is a path is a local server, not a package.
    ["npx ./server", server("npx", ["./server"])],
    ["npx -y /opt/mcp/server", server("npx", ["-y", "/opt/mcp/server"])],
    ["npx ~/mcp/server", server("npx", ["~/mcp/server"])],
    ["npx C:\\mcp\\server", server("npx", ["C:\\mcp\\server"])],
    ["npx -p ../server some-bin", server("npx", ["-p", "../server", "some-bin"])],
    ["uvx ./local-server", server("uvx", ["./local-server"])],
    ["uvx --from ./local-server some-bin", server("uvx", ["--from", "./local-server", "some-bin"])],
    // A pinned package or image after a runner's option values.
    ...[
      "npx -y --registry https://registry.example.com pkg@1.2.3",
      "npx --made-up-option ./x pkg@1.2.3",
      "npm exec --prefix ./tools -- pkg@1.2.3",
      "npx -ws pkg@1.2.3 serve",
      "pnpm dlx --use-stderr pkg@1.2.3 serve",
      "docker run -i --rm --security-opt no-new-privileges mcp/github:1.0",
      "docker run --ipc host mcp/github:1.0",
      "podman run --made-up-option x mcp/github:1.0",
      "docker run -it --rm mcp/github:1.0",
      "docker run -ie TOKEN mcp/github:1.0",
      "pnpm --dir x dlx pkg@1.2.3",
      "uv --directory /x tool run pkg==1.0.0",
      "docker --log-level debug run mcp/github:1.0",
      "docker container run mcp/github:1.0",
      "pnpm --filter x dlx pkg@1.2.3",
      "npx --cache -x pkg@1.2.3",
      "pnpm dlx --cache-dir evil pkg@1.2.3",
      "npx --cache evil pkg@1.2.3",
      "docker run -e -x mcp/github:1.0",
      // npm and pnpm read an option they don't know as a switch, before `dlx` and after it, so `./x` is what runs,
      // a local path; pnpm reads `./x` as its command, never reaching `dlx`.
      "npx --made-up-option ./x pkg",
      "pnpm --made-up-option ./x dlx pkg",
      "pnpm dlx --made-up-option ./x pkg",
      // `uv run` runs a project's command, not a package.
      "uv run pkg",
      "uv --directory /x run pkg",
    ].map(entryWritten),
  ])("gives nothing for %s", (_name, entry) => {
    expect(observe(".mcp.json", mcpJson({ remote: REMOTE, pinned: entry }))).toEqual([]);
  });

  it.each([
    ["one command string", { command: "npx -y some-mcp-server" }],
    ["one command string in capitals", { command: "NPX -y some-mcp-server" }],
    ["one command string with args after it", { command: "npx -y", args: ["some-mcp-server"] }],
    // A command string that starts with a path with a space in it, then the runner's args (#260).
    [
      "one command string with a spaced Windows path",
      { command: "C:\\Program Files\\nodejs\\npx.cmd -y some-mcp-server" },
    ],
    [
      "one command string with a spaced path to cmd",
      { command: "C:\\Program Files\\Windows\\cmd.exe /c npx -y some-mcp-server" },
    ],
    ["cmd /c with separate args", server("cmd", ["/c", "npx", "-y", "some-mcp-server"])],
    ["cmd /c in one command string", { command: "cmd /c npx -y some-mcp-server" }],
  ])("reads the runner from %s as with separate args", (_name, entry) => {
    expect(observe(".mcp.json", mcpJson({ unpinned: entry })).map((o) => o.rule_id)).toEqual([MCP]);
    const pinned = JSON.parse(
      JSON.stringify(entry).replace("some-mcp-server", "some-mcp-server@1.2.3"),
    ) as Record<string, unknown>;
    expect(observe(".mcp.json", mcpJson({ pinned }))).toEqual([]);
  });

  it("reads an .mcp.json in a sub-folder", () => {
    const text = mcpJson({ unpinned: server("npx", ["some-mcp-server"]) });

    expect(observe("apps/web/.mcp.json", text)).toMatchObject([
      { rule_id: MCP, location: { kind: "file", path: "apps/web/.mcp.json", line: 3 } },
    ]);
  });

  it.each(["mcp.json", ".cursor/mcp.json", ".mcp.json.bak", "apps/web/x.mcp.json"])(
    "doesn't read %s",
    (path) => {
      expect(observe(path, mcpJson({ unpinned: server("npx", ["some-mcp-server"]) }))).toEqual([]);
    },
  );

  it.each([
    ["text that isn't JSON", '{ "mcpServers": { "a": { "command": "npx", "args": ["x"] } }'],
    [
      "a top level that is an array",
      '[{ "mcpServers": { "a": { "command": "npx", "args": ["x"] } } }]',
    ],
    ["mcpServers missing", '{ "servers": { "a": { "command": "npx", "args": ["x"] } } }'],
    ["mcpServers a string", '{ "mcpServers": "npx some-mcp-server" }'],
    ["mcpServers an array", '{ "mcpServers": [{ "command": "npx", "args": ["x"] }] }'],
    ["a server entry that is a string", '{ "mcpServers": { "a": "npx some-mcp-server" } }'],
    ["a command that isn't a string", '{ "mcpServers": { "a": { "command": ["npx", "x"] } } }'],
    ["an empty file", ""],
  ])("gives nothing, without throwing, for %s", (_name, text) => {
    expect(observe(".mcp.json", text)).toEqual([]);
  });

  it("reads args that are strings and steps over the rest", () => {
    const text = mcpJson({
      unpinned: { command: "npx", args: [{ y: true }, 3, "some-mcp-server"] },
    });

    expect(observe(".mcp.json", text).map((o) => o.rule_id)).toEqual([MCP]);
  });

  it("reads a file that starts with a byte order mark, on the right line", () => {
    const text = `${String.fromCharCode(0xfeff)}${mcpJson({ unpinned: server("npx", ["some-mcp-server"]) })}`;

    expect(observe(".mcp.json", text)).toMatchObject([
      { rule_id: MCP, location: { kind: "file", path: ".mcp.json", line: 3 } },
    ]);
  });

  it("gives one Observation for a file's unpinned servers, naming the first three and counting the rest, with no argument, env value or URL", () => {
    const text = mcpJson({
      docs: { type: "http", url: `https://example.com/mcp?token=${GITHUB_TOKEN}` },
      github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN } },
      aws: server("npx", ["-y", "aws-mcp", "--key", AWS_KEY]),
      pinned: server("npx", ["-y", "pinned-mcp@1.2.3"]),
      search: server("uvx", ["search-mcp"]),
      browser: server("docker", ["run", "-i", "--rm", "ghcr.io/x/browser"]),
    });

    const observations = observe(".mcp.json", text);

    const line = lineWith(text, '"github"');
    expect(observations).toEqual([
      {
        asset: repo,
        rule_id: MCP,
        location: { kind: "file", path: ".mcp.json", line },
        severity: "medium",
        title: "An MCP server runs without a pinned version",
        evidence: {
          summary: `4 MCP servers without a pinned version (github, aws, search and 1 more) in .mcp.json, first on line ${line}. To fix: ${packRule(MCP).fix}`,
        },
      },
    ]);
    const json = JSON.stringify(observations);
    for (const kept of [GITHUB_TOKEN, AWS_KEY, "example.com", "github-mcp", "aws-mcp", "--key"]) {
      expect(json).not.toContain(kept);
    }
  });

  it("names one unpinned server on its own line", () => {
    const text = mcpJson({ remote: REMOTE, github: server("npx", ["-y", "github-mcp"]) });

    expect(observe(".mcp.json", text)[0]?.evidence.summary).toBe(
      `1 MCP server without a pinned version (github) in .mcp.json, on line ${lineWith(text, '"github"')}. To fix: ${packRule(MCP).fix}`,
    );
  });

  it("shortens a long server key in the summary", () => {
    const key = "k".repeat(500);
    const [observation] = observe(
      ".mcp.json",
      mcpJson({ [key]: server("npx", ["some-mcp-server"]) }),
    );

    expect(observation?.evidence.summary).not.toContain(key);
    expect(observation?.evidence.summary.length).toBeLessThan(400);
  });
});

describe("serverStart's customRegistry: the runner option or env key that points it at another registry (#348)", () => {
  const PRIVATE = "https://r.example";
  const withEnv = (entry: Record<string, unknown>, env: Record<string, unknown>) => ({
    ...entry,
    env,
  });

  it.each([
    ["npx --registry", server("npx", ["-y", "--registry", PRIVATE, "acme-mcp"]), "--registry"],
    [
      "npx --@scope:registry=",
      server("npx", [`--@acme:registry=${PRIVATE}`, "acme-mcp"]),
      "--@acme:registry",
    ],
    [
      "npm's own option, before exec",
      server("npm", ["--reg", PRIVATE, "exec", "acme-mcp"]),
      "--reg",
    ],
    [
      "npx, past -p's package",
      server("npx", ["-p", "acme-mcp", "--registry", PRIVATE, "acme"]),
      "--registry",
    ],
    ["uvx -i", server("uvx", ["-i", PRIVATE, "acme-mcp"]), "-i"],
    [
      "uvx, past --from's package",
      server("uvx", ["--from", "acme", `--find-links=${PRIVATE}`, "acme"]),
      "--find-links",
    ],
    [
      "pipx --pip-args with an index",
      server("pipx", ["run", "--pip-args", `-f ${PRIVATE}`, "acme"]),
      "--pip-args",
    ],
    [
      "a quoted --pip-args in command",
      server(`pipx run --pip-args="--index-url ${PRIVATE}" acme`),
      "--pip-args",
    ],
    [
      "an npm env key, in any case",
      withEnv(server("npx", ["acme-mcp"]), { npm_config_Registry: PRIVATE }),
      "npm_config_Registry",
    ],
    [
      "an npm scope's env key",
      withEnv(server("npx", ["acme-mcp"]), { "NPM_CONFIG_@ACME:REGISTRY": PRIVATE }),
      "NPM_CONFIG_@ACME:REGISTRY",
    ],
    [
      "a Python env key",
      withEnv(server("uvx", ["acme-mcp"]), { PIP_FIND_LINKS: PRIVATE }),
      "PIP_FIND_LINKS",
    ],
  ])("names it for %s", (_case, entry, named) => {
    expect(serverStart(entry)?.customRegistry).toBe(named);
  });

  it.each([
    ["no registry option", server("npx", ["-y", "acme-mcp"])],
    [
      "the server's own option, after its package",
      server("npx", ["acme-mcp", "--registry", PRIVATE]),
    ],
    [
      "the server's own option, after --",
      server("npm", ["exec", "--", "acme-mcp", "--registry", PRIVATE]),
    ],
    ["--pip-args with no index", server("pipx", ["run", "--pip-args=--no-cache-dir", "acme"])],
    [
      "the other runner kind's env key",
      withEnv(server("npx", ["acme-mcp"]), { UV_INDEX_URL: PRIVATE }),
    ],
    [
      "a Python env key in another case",
      withEnv(server("uvx", ["acme-mcp"]), { uv_index_url: PRIVATE }),
    ],
    [
      "an env value that isn't a non-empty string",
      withEnv(server("uvx", ["acme-mcp"]), { UV_INDEX: "", PIP_INDEX_URL: 1 }),
    ],
    [
      "a container image",
      withEnv(server("docker", ["run", "mcp/github"]), { NPM_CONFIG_REGISTRY: PRIVATE }),
    ],
  ])("is undefined for %s", (_case, entry) => {
    expect(serverStart(entry)).toBeDefined();
    expect(serverStart(entry)?.customRegistry).toBeUndefined();
  });

  it("leaves the scanner's Observation as it was: the server is still unpinned", () => {
    const text = mcpJson({ acme: server("npx", ["-y", "--registry", PRIVATE, "acme-mcp"]) });
    expect(observe(".mcp.json", text)).toHaveLength(1);
  });
});
