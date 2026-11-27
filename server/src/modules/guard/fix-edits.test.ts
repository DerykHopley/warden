// Guard's fixed edit per Rule (spec #224, story 6): `fixedEdit(ruleId, location, current, registry)` answers the file
// a Fix PR changes and its new text, or why there's no Fix PR. Each edit is run back through its Rule's own scanner,
// which then reports nothing under that Rule. The registry is a fake: no test reaches npm or PyPI.
import type { Asset, Location } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN, SLACK_TOKEN } from "../../../test/secret-fixtures.ts";
import { agentConfigCheck } from "./agent-config.ts";
import { fixedEdit, fixRefusal, type FixedEdit } from "./fix-edits.ts";
import { mcpServerObservations, type PackageRegistryName } from "./mcp-servers.ts";
import {
  RegistryUnavailable,
  UnpinnableVersion,
  type PackageRegistry,
} from "./package-registry.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const READ_ENV = "guard/agent-can-read-env";
const NO_GUARD = "guard/no-runtime-guard";
const BLANKET = "guard/blanket-bash-allow";
const MCP = "guard/mcp-server-unpinned";

const ENV_DENY = ["Read(./.env)", "Read(./.env.*)"];

const file = (path: string): Location => ({ kind: "file", path });

/** Unicode's line separator, which Markdown and some renderers break a line on. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
/** A C0 or C1 control character, or a Unicode line or paragraph separator. */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** JSON as the edit writes it: two-space indented, with a trailing newline. */
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A fake registry: `versions` holds each `registry:name`'s latest, or the error its lookup throws; any other name isn't
 * on its registry.
 */
function fakeRegistry(versions: Record<string, string | Error> = {}) {
  const asked: string[] = [];
  const registry: PackageRegistry = {
    latestVersion(registry: PackageRegistryName, name: string) {
      asked.push(`${registry}:${name}`);
      const latest = versions[`${registry}:${name}`];
      return latest instanceof Error ? Promise.reject(latest) : Promise.resolve(latest);
    },
  };
  return { registry, asked };
}

const noRegistry = fakeRegistry().registry;

/** The edit, which the test expects to be one rather than a refusal. */
function edited(result: FixedEdit) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

/** The whole-repo Rules a root settings file gives, through `agentConfigCheck`'s `end()`. */
function wholeRepoRules(path: string, text: string): string[] {
  const check = agentConfigCheck(repo);
  check.see({ path, text });
  return (check.end() ?? []).map((observation) => observation.rule_id);
}

const blanketRules = (path: string, text: string) =>
  agentConfigCheck(repo)
    .see({ path, text })
    .filter((observation) => observation.rule_id === BLANKET);

describe("fixedEdit for guard/agent-can-read-env and guard/no-runtime-guard", () => {
  const SETTINGS = ".claude/settings.json";

  it.each([READ_ENV, NO_GUARD])(
    "%s creates .claude/settings.json holding only the two deny entries when it's missing",
    async (rule) => {
      const result = edited(await fixedEdit(rule, file(SETTINGS), undefined, noRegistry));
      expect(result.path).toBe(SETTINGS);
      expect(result.text).toBe(pretty({ permissions: { deny: ENV_DENY } }));
      expect(result.body.join("\n")).toContain("Read(./.env)");
    },
  );

  it("adds them beside an existing allow, hooks and other top-level keys, keeping their values and order", async () => {
    const before = {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["Bash(npm test)"], defaultMode: "default" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
      model: "opus",
    };
    const result = edited(
      await fixedEdit(READ_ENV, file(SETTINGS), JSON.stringify(before), noRegistry),
    );
    expect(result.text).toBe(
      pretty({
        $schema: before.$schema,
        permissions: { allow: ["Bash(npm test)"], defaultMode: "default", deny: ENV_DENY },
        hooks: before.hooks,
        model: "opus",
      }),
    );
  });

  it("adds only the missing one when one is there already", async () => {
    const before = { permissions: { deny: ["Bash(rm:*)", "Read(./.env.*)"] } };
    const result = edited(await fixedEdit(READ_ENV, file(SETTINGS), pretty(before), noRegistry));
    expect(JSON.parse(result.text)).toEqual({
      permissions: { deny: ["Bash(rm:*)", "Read(./.env.*)", "Read(./.env)"] },
    });
  });

  // Bug #320: a file the scanner already clears the Rule for, through a looser match than the two exact entries, is
  // already fixed, so it gets no Fix PR.
  const preToolUse = { PreToolUse: [{ hooks: [{ type: "command", command: "./guard.sh" }] }] };
  it.each([
    [READ_ENV, "a deny of Read(**/.env)", { permissions: { deny: ["Read(**/.env)"] } }],
    [READ_ENV, "a deny of the whole Read tool", { permissions: { deny: ["Read"] } }],
    [READ_ENV, "a deny of Read(./.env) alone", { permissions: { deny: ["Read(./.env)"] } }],
    [NO_GUARD, "any deny entry", { permissions: { deny: ["Bash(rm:*)"] } }],
    [NO_GUARD, "a PreToolUse hook and no deny", { hooks: preToolUse }],
  ])(
    "%s refuses a file holding %s as already fixed, as its scanner clears it",
    async (rule, _case, before) => {
      expect(wholeRepoRules(SETTINGS, pretty(before))).not.toContain(rule);
      const result = await fixedEdit(rule, file(SETTINGS), pretty(before), noRegistry);
      expect(result).toEqual({
        ok: false,
        reason: "already fixed on the default branch; the next Scan marks it Fixed",
      });
    },
  );

  it.each([
    [
      READ_ENV,
      "a deny that doesn't stop a read of .env",
      { permissions: { deny: ["Bash(rm:*)"] } },
    ],
    [READ_ENV, "a PreToolUse hook and no deny", { hooks: preToolUse }],
  ])(
    "%s still edits a file holding %s, as its scanner still reports it",
    async (rule, _case, before) => {
      expect(wholeRepoRules(SETTINGS, pretty(before))).toContain(rule);
      const result = edited(await fixedEdit(rule, file(SETTINGS), pretty(before), noRegistry));
      expect(wholeRepoRules(SETTINGS, result.text)).toEqual([]);
    },
  );

  it("drops a leading byte order mark", async () => {
    const text = `${String.fromCharCode(0xfeff)}${pretty({ permissions: {} })}`;
    const result = edited(await fixedEdit(READ_ENV, file(SETTINGS), text, noRegistry));
    expect(result.text).toBe(pretty({ permissions: { deny: ENV_DENY } }));
  });

  it.each([
    ["a file that isn't JSON", "{ permissions: ", "isn't valid JSON"],
    ["a top level that isn't an object", "[]", "isn't valid JSON"],
    ["a permissions that's a string", pretty({ permissions: "deny" }), "isn't in the shape"],
    ["a deny that's an object", pretty({ permissions: { deny: {} } }), "isn't in the shape"],
    [
      "a file that already holds both",
      pretty({ permissions: { deny: [...ENV_DENY] } }),
      "already fixed on the default branch",
    ],
  ])("refuses %s", async (_case, text, reason) => {
    const result = await fixedEdit(READ_ENV, file(SETTINGS), text, noRegistry);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) as string });
  });

  it("refuses a Location other than the root settings file", async () => {
    const result = await fixedEdit(READ_ENV, file("app/.claude/settings.json"), "{}", noRegistry);
    expect(result).toEqual({ ok: false, reason: "no Fix PR for this Rule" });
  });

  it.each([READ_ENV, NO_GUARD])(
    "clears %s and the other whole-repo Rule, run back through agentConfigCheck",
    async (rule) => {
      const before = pretty({ permissions: { allow: ["Bash(npm test)"] } });
      expect(wholeRepoRules(SETTINGS, before)).toEqual([READ_ENV, NO_GUARD]);
      const result = edited(await fixedEdit(rule, file(SETTINGS), before, noRegistry));
      expect(wholeRepoRules(SETTINGS, result.text)).toEqual([]);
    },
  );
});

describe("fixedEdit for guard/blanket-bash-allow", () => {
  const PATH = "packages/app/.claude/settings.local.json";
  const before = {
    permissions: {
      allow: ["Bash", "Bash(npm test)", "Bash(*)", "Read(*)", "Bash(cat:*)"],
      deny: ["Read(./.env)"],
    },
    env: { NODE_ENV: "development" },
  };

  it("removes each broad entry from a nested folder's settings.local.json and keeps everything else", async () => {
    const result = edited(await fixedEdit(BLANKET, file(PATH), pretty(before), noRegistry));
    expect(result.path).toBe(PATH);
    expect(result.text).toBe(
      pretty({
        permissions: { allow: ["Bash(npm test)", "Read(*)"], deny: ["Read(./.env)"] },
        env: { NODE_ENV: "development" },
      }),
    );
  });

  it("lists the removed entries in the PR body and says to add back exact commands", async () => {
    const { body } = edited(await fixedEdit(BLANKET, file(PATH), pretty(before), noRegistry));
    const text = body.join("\n");
    for (const removed of ["`Bash`", "`Bash(*)`", "`Bash(cat:*)`"]) expect(text).toContain(removed);
    expect(text).not.toContain("`Read(*)`");
    expect(text).toMatch(/add back the exact commands/i);
    expect(text).toContain("Bash(npm test)");
  });

  it("clears the Rule, run back through agentConfigCheck", async () => {
    expect(blanketRules(PATH, pretty(before))).toHaveLength(1);
    const result = edited(await fixedEdit(BLANKET, file(PATH), pretty(before), noRegistry));
    expect(blanketRules(PATH, result.text)).toEqual([]);
  });

  it.each([
    [
      "a file with no broad entry",
      pretty({ permissions: { allow: ["Bash(npm test)"] } }),
      "already fixed",
    ],
    ["a missing file", undefined, "isn't on the default branch"],
    ["a file that isn't JSON", "not json", "isn't valid JSON"],
  ])("refuses %s", async (_case, text, reason) => {
    const result = await fixedEdit(BLANKET, file(PATH), text, noRegistry);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) as string });
  });
});

describe("fixedEdit for guard/mcp-server-unpinned", () => {
  const PATH = "tools/.mcp.json";
  const versions = {
    "npm:@scope/pkg": "1.2.3",
    "npm:some-pkg": "1.2.3",
    "pypi:mcp-server-fetch": "2025.4.7",
    "pypi:mypy": "1.13.0",
    "pypi:pycowsay": "0.0.0.2",
  };
  const DOCKER = { command: "docker", args: ["run", "-i", "--rm", "mcp/github"] };
  const PINNED = { command: "npx", args: ["-y", "pinned-pkg@4.5.6"] };
  const mcpJson = (servers: Record<string, unknown>) => pretty({ mcpServers: servers });

  const fix = async (
    servers: Record<string, unknown>,
    registry = fakeRegistry(versions).registry,
  ) => fixedEdit(MCP, file(PATH), mcpJson(servers), registry);

  it("pins a package in args, keeping its scope", async () => {
    const result = edited(await fix({ scoped: { command: "npx", args: ["-y", "@scope/pkg"] } }));
    expect(result.path).toBe(PATH);
    expect(result.text).toBe(
      mcpJson({ scoped: { command: "npx", args: ["-y", "@scope/pkg@1.2.3"] } }),
    );
  });

  it("pins a package in command, in place, replacing its tag", async () => {
    const result = edited(await fix({ inline: { command: "npx some-pkg@latest" } }));
    expect(JSON.parse(result.text)).toEqual({
      mcpServers: { inline: { command: "npx some-pkg@1.2.3" } },
    });
  });

  it.each([
    [
      "npm exec --package=",
      ["exec", "--package=some-pkg", "--", "some-pkg"],
      "npm",
      ["exec", "--package=some-pkg@1.2.3", "--", "some-pkg"],
    ],
    ["npx -p", ["-p", "@scope/pkg", "pkg-bin"], "npx", ["-p", "@scope/pkg@1.2.3", "pkg-bin"]],
  ])("pins %s where it sits", async (_case, args, command, after) => {
    const result = edited(await fix({ s: { command, args } }));
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { s: { command, args: after } } });
  });

  it("pins a uvx server to PyPI's version, as uv's docs spell a version for the command (command@version)", async () => {
    const result = edited(await fix({ fetch: { command: "uvx", args: ["mcp-server-fetch"] } }));
    expect(JSON.parse(result.text)).toEqual({
      mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch@2025.4.7"] } },
    });
  });

  it.each([
    [
      "uvx --from, extras kept",
      "uvx",
      ["--from", "mypy[reports]", "mypy"],
      ["--from", "mypy[reports]==1.13.0", "mypy"],
    ],
    ["uvx's @latest", "uvx", ["mypy@latest"], ["mypy@1.13.0"]],
    [
      "uv tool run --from=",
      "uv",
      ["tool", "run", "--from=mypy", "mypy"],
      ["tool", "run", "--from=mypy==1.13.0", "mypy"],
    ],
    ["pipx run's package", "pipx", ["run", "pycowsay"], ["run", "pycowsay==0.0.0.2"]],
    [
      "pipx run --spec",
      "pipx",
      ["run", "--spec", "pycowsay", "pycowsay"],
      ["run", "--spec", "pycowsay==0.0.0.2", "pycowsay"],
    ],
  ])("pins %s in the spelling its docs give", async (_case, command, args, after) => {
    const result = edited(await fix({ s: { command, args } }));
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { s: { command, args: after } } });
  });

  it.each([
    ["an npm range", { command: "npx", args: ["-y", "@scope/pkg@^3"] }],
    ["an npm dist-tag", { command: "npx some-pkg@next" }],
    ["a Python specifier", { command: "uvx", args: ["--from", "mypy[reports]>=1", "mypy"] }],
    ["a pipx specifier", { command: "pipx", args: ["run", "--spec", "pycowsay~=0.0", "pycowsay"] }],
  ])(
    "leaves a server naming %s as it is, since latest could be a downgrade, listed by key",
    async (_case, server) => {
      const servers = { ranged: server, scoped: { command: "npx", args: ["-y", "@scope/pkg"] } };
      const { registry, asked } = fakeRegistry(versions);
      const result = edited(await fix(servers, registry));
      expect(JSON.parse(result.text)).toMatchObject({ mcpServers: { ranged: server } });
      expect(result.body.join("\n")).toMatch(/`ranged`: names a version range or tag/);
      expect(asked).toEqual(["npm:@scope/pkg"]);
    },
  );

  it("leaves a package whose latest version Warden can't write as pinned, and pins the others", async () => {
    const { registry } = fakeRegistry({
      ...versions,
      "pypi:epoch-pkg": new UnpinnableVersion("pypi"),
    });
    const servers = {
      epoch: { command: "uvx", args: ["epoch-pkg"] },
      scoped: { command: "npx", args: ["-y", "@scope/pkg"] },
    };
    const result = edited(await fix(servers, registry));
    expect(JSON.parse(result.text)).toEqual({
      mcpServers: {
        epoch: { command: "uvx", args: ["epoch-pkg"] },
        scoped: { command: "npx", args: ["-y", "@scope/pkg@1.2.3"] },
      },
    });
    expect(result.body.join("\n")).toMatch(
      /`epoch`: PyPI's latest version of `epoch-pkg` isn't one Warden can write as pinned/,
    );
  });

  it("keeps each PR body line on one line, and a key's control characters visible, whatever a key holds", async () => {
    const key = "x\n\n@victim [login](https://evil.example)";
    const result = edited(
      await fix({
        [key]: { command: "npx", args: ["-y", "some-pkg"] },
        [`d\r${LINE_SEPARATOR}\u0007`]: DOCKER,
      }),
    );
    for (const line of result.body) {
      expect(line).not.toMatch(LINE_BREAKING);
    }
    const body = result.body.join("\n");
    expect(body).toContain(
      "- `x\\u000a\\u000a@victim [login](https://evil.example)`: `some-pkg@1.2.3`",
    );
    expect(body).toContain("- `d\\u000d\\u2028\\u0007`: a container image gets no Fix PR");
  });

  it("leaves a docker run server and an already pinned one unchanged, and lists the container server by key", async () => {
    const servers = {
      github: DOCKER,
      pinned: PINNED,
      scoped: { command: "npx", args: ["-y", "@scope/pkg"] },
    };
    const result = edited(await fix(servers));
    const after = JSON.parse(result.text) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers.github).toEqual(DOCKER);
    expect(after.mcpServers.pinned).toEqual(PINNED);
    const body = result.body.join("\n");
    expect(body).toMatch(/`github`.*a container image gets no Fix PR/);
    expect(body).toContain("`@scope/pkg@1.2.3`");
    // The server already pinned isn't listed: its key never shows.
    expect(body).not.toContain("`pinned`");
  });

  it("says, beside a container server left as it is, that the Finding stays Open until it's pinned by hand", async () => {
    const result = edited(
      await fix({ github: DOCKER, scoped: { command: "npx", args: ["-y", "@scope/pkg"] } }),
    );
    const at = result.body.indexOf("Left as they are:");
    expect(result.body[at + 1]).toMatch(/^- `github`: a container image gets no Fix PR$/);
    expect(result.body.at(-1)).toBe(
      "The Finding stays Open after this PR merges, until the servers left as they are are pinned by hand.",
    );
  });

  it("says nothing of the Finding staying Open when every unpinned server is pinned", async () => {
    const result = edited(await fix({ scoped: { command: "npx", args: ["-y", "@scope/pkg"] } }));
    expect(result.body.join("\n")).not.toContain("stays Open");
  });

  it("leaves a package its registry doesn't hold, listed by key with the reason", async () => {
    const result = edited(
      await fix({
        scoped: { command: "npx", args: ["-y", "@scope/pkg"] },
        gone: { command: "npx", args: ["-y", "not-on-npm"] },
      }),
    );
    expect(JSON.parse(result.text)).toMatchObject({
      mcpServers: { gone: { command: "npx", args: ["-y", "not-on-npm"] } },
    });
    expect(result.body.join("\n")).toMatch(/`gone`.*npm doesn't hold `not-on-npm`/);
  });

  it("clears the Rule, run back through mcpServerObservations", async () => {
    const servers = {
      scoped: { command: "npx", args: ["-y", "@scope/pkg"] },
      inline: { command: "npx some-pkg@latest" },
      fetch: { command: "uvx", args: ["mcp-server-fetch"] },
      mypy: { command: "uvx", args: ["--from", "mypy[reports]", "mypy"] },
      cow: { command: "pipx", args: ["run", "pycowsay"] },
      pinned: PINNED,
    };
    expect(mcpServerObservations(repo, { path: PATH, text: mcpJson(servers) })).toHaveLength(1);
    const result = edited(await fix(servers));
    expect(mcpServerObservations(repo, { path: PATH, text: result.text })).toEqual([]);
  });

  it("names servers by key and package only: no other argument, env value or url reaches the PR body", async () => {
    const result = edited(
      await fix({
        scoped: {
          command: "npx",
          args: ["-y", "@scope/pkg", "--token", GITHUB_TOKEN],
          env: { SLACK_TOKEN },
        },
        github: {
          ...DOCKER,
          args: [...DOCKER.args, `--api-key=${GITHUB_TOKEN}`],
          env: { SLACK_TOKEN },
        },
        remote: { type: "http", url: `https://example.com/mcp?token=${GITHUB_TOKEN}` },
        gone: { command: "npx", args: ["-y", `git+https://${GITHUB_TOKEN}@github.com/o/r.git`] },
      }),
    );
    const body = result.body.join("\n");
    for (const secret of [GITHUB_TOKEN, SLACK_TOKEN, "example.com", "--token"]) {
      expect(body).not.toContain(secret);
    }
    expect(body).toMatch(/`gone`/);
  });

  it("asks the registry once per package, and passes up RegistryUnavailable", async () => {
    const { registry, asked } = fakeRegistry(versions);
    await fix(
      {
        a: { command: "npx", args: ["-y", "some-pkg"] },
        b: { command: "npx", args: ["-y", "some-pkg@latest"] },
      },
      registry,
    );
    expect(asked).toEqual(["npm:some-pkg"]);
    const down: PackageRegistry = {
      latestVersion: () => Promise.reject(new RegistryUnavailable("npm", 503)),
    };
    await expect(
      fix({ a: { command: "npx", args: ["-y", "some-pkg"] } }, down),
    ).rejects.toBeInstanceOf(RegistryUnavailable);
  });

  describe("a server whose runner is pointed at a registry other than the public one (#348)", () => {
    const PRIVATE = "https://r.example";
    const PUBLIC = { scoped: { command: "npx", args: ["-y", "@scope/pkg"] } };

    const both = { "npm:acme-mcp": "9.9.9", "pypi:acme-mcp": "9.9.9" };

    it.each([
      ["--registry", "npx", ["-y", "--registry", PRIVATE, "acme-mcp"], undefined],
      ["--registry", "npx", ["-y", `--registry=${PRIVATE}`, "acme-mcp"], undefined],
      ["--reg", "npx", ["-y", "--reg", PRIVATE, "acme-mcp"], undefined],
      ["--@acme:registry", "npx", ["-y", `--@acme:registry=${PRIVATE}`, "acme-mcp"], undefined],
      ["--registry", "npm", ["--registry", PRIVATE, "exec", "acme-mcp"], undefined],
      ["--registry", "pnpm", ["dlx", "--registry", PRIVATE, "acme-mcp"], undefined],
      ["--index-url", "uvx", ["--index-url", PRIVATE, "acme-mcp"], undefined],
      ["--extra-index-url", "uvx", [`--extra-index-url=${PRIVATE}`, "acme-mcp"], undefined],
      ["--index", "uv", ["tool", "run", "--index", PRIVATE, "acme-mcp"], undefined],
      ["-f", "uvx", ["-f", "./wheels", "acme-mcp"], undefined],
      ["--pip-args", "pipx", ["run", `--pip-args="--index-url ${PRIVATE}"`, "acme-mcp"], undefined],
      ["NPM_CONFIG_REGISTRY", "npx", ["-y", "acme-mcp"], { NPM_CONFIG_REGISTRY: PRIVATE }],
      ["UV_INDEX_URL", "uvx", ["acme-mcp"], { UV_INDEX_URL: PRIVATE }],
    ])(
      "leaves %s on `%s %j`, asking no registry, naming it and never its value",
      async (what, command, args, env) => {
        const { registry, asked } = fakeRegistry(both);
        const server = { command, args, ...(env === undefined ? {} : { env }) };
        const result = await fix({ acme: server }, registry);
        if (result.ok) throw new Error("expected a refusal");
        expect(asked).toEqual([]);
        expect(result.reason).toBe(
          `no server can be pinned: \`acme\`: uses a private registry (\`${what}\`)`,
        );
        expect(result.reason).not.toContain(PRIVATE);
      },
    );

    it.each([
      [
        "pipx's --pip-args without an index",
        { command: "pipx", args: ["run", "--pip-args=--no-cache-dir", "acme-mcp"] },
        "pypi:acme-mcp",
        ["run", "--pip-args=--no-cache-dir", "acme-mcp==9.9.9"],
      ],
      [
        "the other runner kind's env key",
        { command: "npx", args: ["-y", "acme-mcp"], env: { UV_INDEX_URL: PRIVATE } },
        "npm:acme-mcp",
        ["-y", "acme-mcp@9.9.9"],
      ],
    ])("pins a server with %s as before", async (_case, server, lookup, pinned) => {
      const { registry, asked } = fakeRegistry(both);
      const result = edited(await fix({ acme: server }, registry));
      expect(asked).toEqual([lookup]);
      const after = JSON.parse(result.text) as { mcpServers: { acme: { args: string[] } } };
      expect(after.mcpServers.acme.args).toEqual(pinned);
      expect(result.body.join("\n")).not.toContain(PRIVATE);
    });

    it("pins a server whose own option, after its package, names a registry, as before", async () => {
      const { registry, asked } = fakeRegistry({ "npm:acme-mcp": "9.9.9" });
      const server = { command: "npx", args: ["-y", "acme-mcp", "--registry", PRIVATE] };
      const result = edited(await fix({ acme: server }, registry));
      expect(asked).toEqual(["npm:acme-mcp"]);
      const after = JSON.parse(result.text) as { mcpServers: { acme: { args: string[] } } };
      expect(after.mcpServers.acme.args).toEqual(["-y", "acme-mcp@9.9.9", "--registry", PRIVATE]);
    });

    it("pins the public server beside it and lists the private one under Left as they are", async () => {
      const { registry, asked } = fakeRegistry(versions);
      const priv = { command: "npx", args: ["-y", "--registry", PRIVATE, "acme-mcp"] };
      const result = edited(await fix({ ...PUBLIC, acme: priv }, registry));
      expect(asked).toEqual(["npm:@scope/pkg"]);
      expect(JSON.parse(result.text)).toEqual({
        mcpServers: { scoped: { command: "npx", args: ["-y", "@scope/pkg@1.2.3"] }, acme: priv },
      });
      const at = result.body.indexOf("Left as they are:");
      expect(result.body[at + 1]).toBe("- `acme`: uses a private registry (`--registry`)");
      expect(result.body.join("\n")).not.toContain(PRIVATE);
    });
  });

  it.each([
    [
      "a file whose only unpinned server is a container image",
      mcpJson({ github: DOCKER, pinned: PINNED }),
      "no server can be pinned: `github`: a container image gets no Fix PR",
    ],
    [
      "a file whose unpinned server its registry doesn't hold",
      mcpJson({ gone: { command: "npx", args: ["not-on-npm"] } }),
      "no server can be pinned: `gone`: npm doesn't hold `not-on-npm`",
    ],
    [
      "a file whose unpinned server's package word can't be read",
      mcpJson({ alias: { command: "npx", args: ["-y", "alias@npm:other-pkg"] } }),
      "no server can be pinned: `alias`: not a package Warden can pin from npm",
    ],
    [
      "a file whose unpinned server names a range",
      mcpJson({ ranged: { command: "npx", args: ["-y", "some-pkg@^1"] } }),
      "no server can be pinned: `ranged`: names a version range or tag",
    ],
    [
      "a file whose servers can't be pinned for different reasons",
      mcpJson({ github: DOCKER, gone: { command: "npx", args: ["not-on-npm"] } }),
      "no server can be pinned: `github`: a container image gets no Fix PR; `gone`: npm doesn't hold `not-on-npm`",
    ],
    ["a file with no unpinned server", mcpJson({ pinned: PINNED }), "already fixed"],
    ["a missing file", undefined, "isn't on the default branch"],
    ["a file that isn't JSON", "{", "isn't valid JSON"],
  ])("refuses %s", async (_case, text, reason) => {
    const result = await fixedEdit(MCP, file(PATH), text, fakeRegistry(versions).registry);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) as string });
  });
});

describe("fixedEdit never changes what its edit doesn't mean to", () => {
  /** A file for each Rule that its edit changes, with `extra` as one more top-level member, written as it is. */
  const files = (extra: string) =>
    [
      [READ_ENV, ".claude/settings.json", `{"permissions": {"allow": ["Read(*)"]}, ${extra}}`],
      [BLANKET, ".claude/settings.json", `{"permissions": {"allow": ["Bash(*)"]}, ${extra}}`],
      [
        MCP,
        ".mcp.json",
        `{"mcpServers": {"s": {"command": "npx", "args": ["some-pkg"]}}, ${extra}}`,
      ],
    ] as const;
  const registry = fakeRegistry({ "npm:some-pkg": "1.2.3" }).registry;

  it.each([
    ["a number past 2^53", `"cleanupPeriodDays": 12345678901234567890`],
    ["a number past a double's range", `"x": 1e400`],
    ["minus zero", `"x": [-0]`],
    ["a number JSON would write another way", `"x": {"y": 1.50}`],
  ])("refuses a file holding %s", async (_case, extra) => {
    for (const [rule, path, text] of files(extra)) {
      const result = await fixedEdit(rule, file(path), text, registry);
      expect(result).toEqual({
        ok: false,
        reason: `${path} holds a number that rewriting it as JSON would change; Warden never changes what its edit doesn't mean to`,
      });
    }
  });

  it.each([
    ["an integer-like key after another", `"env": {"NODE_ENV": "test", "10": "x"}`],
    ["a repeated key", `"model": "opus", "model": "sonnet"`],
  ])("refuses a file holding %s", async (_case, extra) => {
    for (const [rule, path, text] of files(extra)) {
      const result = await fixedEdit(rule, file(path), text, registry);
      expect(result).toEqual({
        ok: false,
        reason: `${path}'s keys would move or be dropped when it's rewritten as JSON; Warden never changes what its edit doesn't mean to`,
      });
    }
  });

  it("edits a file whose numbers, keys and strings JSON writes back the same", async () => {
    const extra = `"n": [0, -3, 0.5, 30, 1.25e-7], "env": {"0": "first", "1": "next", "A": "\\u0041\\/"}`;
    for (const [rule, path, text] of files(extra)) {
      edited(await fixedEdit(rule, file(path), text, registry));
    }
  });
});

describe("fixRefusal: whether a Finding's Rule and Location can get a Fix PR, without its file", () => {
  it.each([
    [READ_ENV, ".claude/settings.json"],
    [NO_GUARD, ".claude/settings.json"],
    [BLANKET, "packages/app/.claude/settings.local.json"],
    [MCP, "tools/.mcp.json"],
  ])("answers undefined for %s at %s", (rule, path) => {
    expect(fixRefusal(rule, file(path))).toBeUndefined();
  });

  it.each([
    [
      "another Rule",
      "guard/permission-skip",
      file(".claude/settings.json"),
      "no Fix PR for this Rule",
    ],
    ["a non-file Location", MCP, { kind: "session" } as const, "no Fix PR for this Rule"],
    [
      "a path under .github/workflows/",
      MCP,
      file(".github/workflows/.mcp.json"),
      "Warden never edits .github/workflows/",
    ],
    [
      "a fixable Rule at another file",
      READ_ENV,
      file("app/.claude/settings.json"),
      "no Fix PR for this Rule",
    ],
  ] as const)("answers a reason for %s", (_name, rule, location, reason) => {
    expect(fixRefusal(rule, location)).toBe(reason);
  });
});

describe("fixedEdit refuses", () => {
  it.each([MCP, BLANKET, READ_ENV])("%s at a path under .github/workflows/", async (rule) => {
    const result = await fixedEdit(rule, file(".github/workflows/.mcp.json"), "{}", noRegistry);
    expect(result).toEqual({ ok: false, reason: "Warden never edits .github/workflows/" });
  });

  it.each([
    ["guard/permission-skip", file("scripts/run.sh")],
    ["guard/secret-in-repo", file(".env")],
    [MCP, { kind: "session" } as const],
    [BLANKET, file("README.md")],
    [MCP, file("mcp.json")],
  ] as const)("%s at %j: no Fix PR for this Rule", async (rule, location) => {
    const result = await fixedEdit(rule, location, "{}", noRegistry);
    expect(result).toEqual({ ok: false, reason: "no Fix PR for this Rule" });
  });
});
