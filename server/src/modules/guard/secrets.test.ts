// Guard's secret Rules (Guard spec, story 3): `findSecrets` finds each fixed secret type and answers it masked, and
// `secretObservations` turns one file's secrets into at most one Observation per Rule. Each fixture secret is built
// by joining its parts, so the source never holds a whole one for a secret scanner to flag.
import { Observation, SecretEvidence, type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { join, SECRET_OF_EACH_TYPE as SECRETS } from "../../../test/secret-fixtures.ts";
import { packRule } from "./default-pack.ts";
import { findSecrets, secretObservations } from "./secrets.ts";

/** The other GitHub token prefixes, and a fine-grained one. */
const GITHUB_TOKENS = [
  ...["gho", "ghu", "ghs", "ghr"].map((prefix) =>
    join(prefix, "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"),
  ),
  join("github", "_pat_", "11ABCDEFG0123456789abc", "_", "Qw3".repeat(19), "rTy"),
];

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

describe("findSecrets", () => {
  it.each(Object.entries(SECRETS))("finds a %s, masked", (type, secret) => {
    const text = `first line\nconst value = "${secret}";\n`;

    const found = findSecrets("src/config.ts", text);

    expect(found).toEqual([
      { type, path: "src/config.ts", line: 2, mask: `${secret.slice(0, 4)}********` },
    ]);
    expect(SecretEvidence.safeParse(found[0]).success).toBe(true);
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it.each(GITHUB_TOKENS)("finds the GitHub token %#", (secret) => {
    expect(findSecrets("a.txt", `token: ${secret}`)).toEqual([
      expect.objectContaining({ type: "GitHub token", line: 1 }),
    ]);
  });

  it("answers each secret on its own line, in order", () => {
    const text = [SECRETS["Google API key"], "", `a ${SECRETS["GitHub token"]} b`].join("\n");

    expect(findSecrets("a.txt", text).map(({ type, line }) => [type, line])).toEqual([
      ["Google API key", 1],
      ["GitHub token", 3],
    ]);
  });

  it("finds nothing in a file with no secret", () => {
    expect(findSecrets("README.md", "# App\n\nRun `pnpm dev`, then open the dashboard.\n")).toEqual(
      [],
    );
  });

  it.each([
    ["an AWS placeholder", 'aws_access_key_id = "AKIAEXAMPLE"'],
    ["AWS's documented example key", join('aws_access_key_id = "AKIA', 'IOSFODNN7EXAMPLE"')],
    ["a Slack placeholder", join('SLACK_BOT_TOKEN="xox', 'b-your-bot-token-here"')],
    ["an OpenAI placeholder", join('OPENAI_API_KEY="sk-', 'proj-your-api-key-goes-here"')],
    ["a GitHub token of one repeated character", join("token: ghp", "_", "x".repeat(36))],
    ["a short GitHub-like word", "see ghp_docs for the format"],
    ["a public key", join("-----BEGIN ", "PUBLIC KEY-----")],
    ["a Stripe test key", join("sk", "_test_", "4eC39HqLyjWDarjtT1zdp7dc")],
    ["an environment variable name", "OPENAI_API_KEY=${OPENAI_API_KEY}"],
  ])("finds nothing in %s", (_name, text) => {
    expect(findSecrets("src/config.ts", text)).toEqual([]);
  });
});

describe("secretObservations", () => {
  const secret = SECRETS["AWS access key id"];

  it.each([
    ".claude/settings.local.json",
    ".claude/settings.json",
    "sub/.claude/settings.json",
    ".mcp.json",
  ])("reports a secret in %s under guard/secret-in-agent-settings", (path) => {
    expect(secretObservations(repo, { path, text: secret }).map((o) => o.rule_id)).toEqual([
      "guard/secret-in-agent-settings",
    ]);
  });

  it.each(["src/config.ts", "claude/settings.json", "docs/.mcp.json.md", ".claude/other.json"])(
    "reports a secret in %s under guard/secret-in-repo",
    (path) => {
      expect(secretObservations(repo, { path, text: secret }).map((o) => o.rule_id)).toEqual([
        "guard/secret-in-repo",
      ]);
    },
  );

  it("gives one Observation for a file with three secrets: the first one's line and mask, and a count", () => {
    const text = [
      "// config",
      `const github = "${SECRETS["GitHub token"]}";`,
      "",
      `const aws = "${secret}";`,
      `const other = "${SECRETS["GitHub token"]}";`,
    ].join("\n");

    const observations = secretObservations(repo, { path: "config/app.ts", text });

    expect(observations).toEqual([
      {
        asset: repo,
        rule_id: "guard/secret-in-repo",
        location: { kind: "file", path: "config/app.ts", line: 2 },
        severity: "high",
        title: "A secret is committed to the repo",
        evidence: {
          summary: `3 secrets (GitHub token, AWS access key id) in config/app.ts, first on line 2. To fix: ${packRule("guard/secret-in-repo").fix}`,
          secret: { type: "GitHub token", path: "config/app.ts", line: 2, mask: "ghp_********" },
        },
      },
    ]);
    expect(Observation.safeParse(observations[0]).success).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(secret);
    expect(JSON.stringify(observations)).not.toContain(SECRETS["GitHub token"]);
  });

  it("words one secret alone, and ends with the agent settings fix", () => {
    const [observation] = secretObservations(repo, {
      path: ".mcp.json",
      text: `{\n  "env": { "KEY": "${secret}" }\n}`,
    });

    expect(observation!.evidence.summary).toBe(
      `1 secret (AWS access key id) in .mcp.json, on line 2. To fix: ${packRule("guard/secret-in-agent-settings").fix}`,
    );
    expect(observation!.title).toBe("A secret sits in an agent settings file");
  });

  it("gives no Observation for a file with no secret", () => {
    expect(secretObservations(repo, { path: "src/app.ts", text: "export const x = 1;\n" })).toEqual(
      [],
    );
  });
});
