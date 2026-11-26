// Guard's fixed edit per Rule (spec #224, story 6): `fixedEdit(ruleId, location, current, registry)` answers the file
// a Fix PR changes and its new text, or why there's no Fix PR. Each edit is run back through its Rule's own scanner,
// which then reports nothing under that Rule. The registry is a fake: no test reaches npm or PyPI.
import type { Asset, Location } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN, SLACK_TOKEN } from "../../../test/secret-fixtures.ts";
import { agentConfigCheck } from "./agent-config.ts";
import { fixedEdit, type FixedEdit } from "./fix-edits.ts";
import { mcpServerObservations, type PackageRegistryName } from "./mcp-servers.ts";
import { RegistryUnavailable, type PackageRegistry } from "./package-registry.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const READ_ENV = "guard/agent-can-read-env";
const NO_GUARD = "guard/no-runtime-guard";
const BLANKET = "guard/blanket-bash-allow";
const MCP = "guard/mcp-server-unpinned";

const ENV_DENY = ["Read(./.env)", "Read(./.env.*)"];

const file = (path: string): Location => ({ kind: "file", path });

/** JSON as the edit writes it: two-space indented, with a trailing newline. */
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A fake registry: `versions` holds each `registry:name`'s latest; any other name isn't on its registry. */
function fakeRegistry(versions: Record<string, string> = {}) {
  const asked: string[] = [];
  const registry: PackageRegistry = {
    latestVersion(name: PackageRegistryName, pkg: string) {
      asked.push(`${name}:${pkg}`);
      return Promise.resolve(versions[`${name}:${pkg}`]);
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
    const before = { permissions: { deny: ["Bash(rm:*)", "Read(./.env)"] } };
    const result = edited(await fixedEdit(NO_GUARD, file(SETTINGS), pretty(before), noRegistry));
    expect(JSON.parse(result.text)).toEqual({
      permissions: { deny: ["Bash(rm:*)", "Read(./.env)", "Read(./.env.*)"] },
    });
  });

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
      "an npm range",
      ["exec", "--package=some-pkg@^1", "--", "some-pkg"],
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
      ["--from", "mypy[reports]>=1", "mypy"],
      ["--from", "mypy[reports]==1.13.0", "mypy"],
    ],
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
      ["run", "--spec", "pycowsay>=0.0.0.1", "pycowsay"],
      ["run", "--spec", "pycowsay==0.0.0.2", "pycowsay"],
    ],
  ])("pins %s in the spelling its docs give", async (_case, command, args, after) => {
    const result = edited(await fix({ s: { command, args } }));
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { s: { command, args: after } } });
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
    expect(body).not.toContain("pinned");
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
      mypy: { command: "uvx", args: ["--from", "mypy[reports]>=1", "mypy"] },
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

  it.each([
    [
      "a file whose only unpinned server is a container image",
      mcpJson({ github: DOCKER, pinned: PINNED }),
      "no server",
    ],
    [
      "a file whose unpinned server its registry doesn't hold",
      mcpJson({ gone: { command: "npx", args: ["not-on-npm"] } }),
      "no server",
    ],
    ["a file with no unpinned server", mcpJson({ pinned: PINNED }), "already fixed"],
    ["a missing file", undefined, "isn't on the default branch"],
    ["a file that isn't JSON", "{", "isn't valid JSON"],
  ])("refuses %s", async (_case, text, reason) => {
    const result = await fixedEdit(MCP, file(PATH), text, fakeRegistry(versions).registry);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) as string });
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
