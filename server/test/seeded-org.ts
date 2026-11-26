// The Seeded org (GLOSSARY): Warden's own repos with planted problems, kept here as labelled fixtures so the rules eval
// (`rules-eval.test.ts`, Guard spec story 13) runs in CI with no network. Each repo is a name, a ref, its files and its
// labels. A label is a Rule id and a path: a Finding a correct Scan opens. Each repo also lists its near misses: cases
// that look like a Rule's problem but aren't one, so a Rule that reports them loses precision. The cases are labelled
// to what the Rules should find, not to what they find today.
//
// Every planted secret comes from `secret-fixtures.ts`, and the skip flag and the bypass mode are joined from parts
// here, so neither this file nor the eval holds a whole secret or flag for a Guard Scan of Warden to report.
import type { RuleId } from "@warden/contracts";
import { WHOLE_REPO_PATH } from "../src/modules/guard/agent-config.ts";
import {
  AGENT_CAN_READ_ENV,
  BLANKET_BASH_ALLOW,
  MCP_SERVER_UNPINNED,
  NO_RUNTIME_GUARD,
  PERMISSION_SKIP,
  SECRET_IN_AGENT_SETTINGS,
  SECRET_IN_REPO,
  UNAPPROVED_AI_TOOL,
} from "../src/modules/guard/default-pack.ts";
import type { RepoFile, UnreadFile } from "../src/modules/guard/repo-reader.ts";
import {
  ANTHROPIC_KEY,
  AWS_KEY,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  STRIPE_KEY,
} from "./secret-fixtures.ts";

export type SeededRepo = {
  name: string;
  /** The repo's URL, the Repo Asset's ref. */
  ref: string;
  files: readonly (RepoFile | UnreadFile)[];
  /** Each Finding a correct Scan of the repo opens: its Rule and its Location's path. */
  labels: readonly { rule: RuleId; path: string }[];
  /** Each case in the repo that a Rule should leave alone, at the path it sits in, and what it is. */
  nearMisses: readonly { rule: RuleId; path: string; what: string }[];
};

/** Every secret planted in the Seeded org's files. */
export const PLANTED_SECRETS: readonly string[] = [
  AWS_KEY,
  GITHUB_TOKEN,
  STRIPE_KEY,
  ANTHROPIC_KEY,
  SLACK_TOKEN,
];

const join = (...parts: string[]) => parts.join("");
/** The flag that starts Claude Code with its permission checks off. */
const FLAG = join("--dangerously", "-skip-permissions");
/** The permission mode that skips the checks. */
const BYPASS = join("bypass", "Permissions");

/** Where every whole-repo Observation sits: the root settings file a fix goes in. */
const SETTINGS = WHOLE_REPO_PATH;
const LOCAL_SETTINGS = ".claude/settings.local.json";

/** A JSON config file's text, pretty-printed as Claude Code writes it. */
const json = (path: string, config: Record<string, unknown>): RepoFile => ({
  path,
  text: `${JSON.stringify(config, null, 2)}\n`,
});

/** A settings file's `hooks` key: one matcher group under `event`, holding one command hook. */
const hook = (event: string, command: string) => ({
  [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }],
});

/** The deny rules that keep the agent off `.env` files: a guard, so neither whole-repo Rule answers. */
const DENY_ENV = ["Read(./.env)", "Read(./.env.*)"];

const CLAUDE_MD: RepoFile = {
  path: "CLAUDE.md",
  text: "# Working here\n\nRun `npm test` before each commit.\n",
};

const repo = (name: string, rest: Omit<SeededRepo, "name" | "ref">): SeededRepo => ({
  name,
  ref: `https://github.com/warden-seeded-org/${name}`,
  ...rest,
});

export const SEEDED_ORG: readonly SeededRepo[] = [
  // No problem at all, and a near miss for every Rule.
  repo("docs-site", {
    files: [
      CLAUDE_MD,
      { path: "AGENTS.md", text: "# Agents\n\nUse the style guide in docs/style.md.\n" },
      {
        path: "README.md",
        text: `# Docs site\n\nNever start the agent with \`claude ${FLAG}\`: it skips every permission check.\n`,
      },
      {
        path: "src/config.ts",
        text: 'export const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "sk-ant-your-key-here-replace-before-deploy";\n',
      },
      json(SETTINGS, {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        env: { OPENAI_API_KEY: "sk-proj-your-key-here-replace-before-deploy" },
        permissions: {
          allow: ["Bash(npm test)", "Bash(npm run build)"],
          deny: DENY_ENV,
        },
        hooks: hook("PreToolUse", "./scripts/agent-guard.sh"),
      }),
      { path: "scripts/agent-guard.sh", text: "#!/bin/sh\nexit 0\n" },
      json(".mcp.json", {
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "./docs"],
          },
          search: { type: "http", url: "https://mcp.search.invalid/mcp" },
        },
      }),
    ],
    labels: [],
    nearMisses: [
      { rule: SECRET_IN_REPO, path: "src/config.ts", what: "a placeholder key in a source file" },
      {
        rule: SECRET_IN_AGENT_SETTINGS,
        path: SETTINGS,
        what: "a placeholder key in a settings file",
      },
      { rule: BLANKET_BASH_ALLOW, path: SETTINGS, what: "narrow Bash allows (Bash(npm test))" },
      { rule: PERMISSION_SKIP, path: "README.md", what: "the skip flag in a README" },
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS, what: "a Read(./.env) deny" },
      { rule: NO_RUNTIME_GUARD, path: SETTINGS, what: "deny rules and a PreToolUse hook" },
      { rule: MCP_SERVER_UNPINNED, path: ".mcp.json", what: "a pinned and a remote MCP server" },
      { rule: UNAPPROVED_AI_TOOL, path: "AGENTS.md", what: "an AGENTS.md alone" },
    ],
  }),

  // No Claude Code path: neither whole-repo Rule answers, though nothing guards an agent.
  repo("billing-api", {
    files: [
      { path: "README.md", text: "# Billing API\n\nCharges and invoices.\n" },
      {
        path: "src/config.ts",
        text: `export const region = "eu-west-1";\nexport const awsAccessKeyId = "${AWS_KEY}";\n`,
      },
      {
        path: "scripts/deploy.sh",
        text: `#!/bin/sh\n# Don't run the agent with ${FLAG} on a deploy box.\nnpm run build && ./bin/release\n`,
      },
      { path: ".cursorrules", text: "Prefer small functions.\n" },
    ],
    labels: [
      { rule: SECRET_IN_REPO, path: "src/config.ts" },
      // A tool's Finding sits at its fixed Location, whichever of its paths the repo holds.
      { rule: UNAPPROVED_AI_TOOL, path: ".cursor" },
    ],
    nearMisses: [
      { rule: PERMISSION_SKIP, path: "scripts/deploy.sh", what: "the skip flag on a comment line" },
    ],
  }),

  // Everything allowed: the whole Bash tool, no deny rule, no hook, and a token in the local settings.
  repo("agent-playground", {
    files: [
      CLAUDE_MD,
      json(SETTINGS, { permissions: { allow: ["Bash", "Edit"] } }),
      json(LOCAL_SETTINGS, { env: { GITHUB_TOKEN } }),
    ],
    labels: [
      { rule: BLANKET_BASH_ALLOW, path: SETTINGS },
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS },
      { rule: NO_RUNTIME_GUARD, path: SETTINGS },
      { rule: SECRET_IN_AGENT_SETTINGS, path: LOCAL_SETTINGS },
    ],
    nearMisses: [],
  }),

  // The skip flag in a script and the bypass mode in the local settings; a comment line only mentions it.
  repo("ci-tools", {
    files: [
      CLAUDE_MD,
      json(SETTINGS, { permissions: { allow: ["Bash(npm test)"], deny: DENY_ENV } }),
      json(LOCAL_SETTINGS, { permissions: { defaultMode: BYPASS } }),
      {
        path: "scripts/review.sh",
        text: `#!/usr/bin/env bash\nset -euo pipefail\nclaude -p "Review the diff" ${FLAG}\n`,
      },
      {
        path: ".github/workflows/lint.yml",
        text: `name: lint\non: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      # A review step would run: claude -p x ${FLAG}\n      - run: npm run lint\n`,
      },
    ],
    labels: [
      { rule: PERMISSION_SKIP, path: "scripts/review.sh" },
      { rule: PERMISSION_SKIP, path: LOCAL_SETTINGS },
    ],
    nearMisses: [
      {
        rule: PERMISSION_SKIP,
        path: ".github/workflows/lint.yml",
        what: "the skip flag on a YAML comment line",
      },
      { rule: BLANKET_BASH_ALLOW, path: SETTINGS, what: "a narrow Bash allow (Bash(npm test))" },
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS, what: "a Read(./.env) deny" },
    ],
  }),

  // An MCP server from npx with no version, and a Slack token in its env.
  repo("mcp-gateway", {
    files: [
      CLAUDE_MD,
      json(SETTINGS, { permissions: { deny: DENY_ENV } }),
      json(".mcp.json", {
        mcpServers: {
          slack: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-slack"],
            env: { SLACK_BOT_TOKEN: SLACK_TOKEN },
          },
          docs: { type: "sse", url: "https://mcp.docs.invalid/sse" },
        },
      }),
    ],
    labels: [
      { rule: MCP_SERVER_UNPINNED, path: ".mcp.json" },
      { rule: SECRET_IN_AGENT_SETTINGS, path: ".mcp.json" },
    ],
    nearMisses: [
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS, what: "a Read(./.env) deny" },
      { rule: MCP_SERVER_UNPINNED, path: ".mcp.json", what: "a remote MCP server" },
    ],
  }),

  // A guard hook but no deny rule, a nested MCP config, a key in Python, and Cursor rules it couldn't read.
  repo("data-pipeline", {
    files: [
      json(SETTINGS, {
        hooks: hook("PreToolUse", "python3 .claude/hooks/guard.py"),
      }),
      {
        path: ".claude/hooks/guard.py",
        text: "import sys\n\nsys.exit(0)\n",
      },
      json("tools/.mcp.json", {
        mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
      }),
      {
        path: "src/settings.py",
        text: `MODEL = "claude-sonnet"\nANTHROPIC_API_KEY = "${ANTHROPIC_KEY}"\n`,
      },
      { path: ".cursor/rules/pipeline.mdc", unread: true },
    ],
    labels: [
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS },
      { rule: MCP_SERVER_UNPINNED, path: "tools/.mcp.json" },
      { rule: SECRET_IN_REPO, path: "src/settings.py" },
      { rule: UNAPPROVED_AI_TOOL, path: ".cursor" },
    ],
    nearMisses: [
      { rule: NO_RUNTIME_GUARD, path: SETTINGS, what: "a PreToolUse hook with no deny rule" },
    ],
  }),

  // A Stop hook that runs the agent with the skip flag, and a cat allow in the local settings.
  repo("release-bot", {
    files: [
      CLAUDE_MD,
      json(SETTINGS, {
        permissions: { allow: ["Bash(git log:*)"], deny: DENY_ENV },
        hooks: hook("Stop", `claude -p x ${FLAG}`),
      }),
      json(LOCAL_SETTINGS, { permissions: { allow: ["Bash(cat:*)"] } }),
    ],
    labels: [
      { rule: PERMISSION_SKIP, path: SETTINGS },
      { rule: BLANKET_BASH_ALLOW, path: LOCAL_SETTINGS },
    ],
    nearMisses: [
      {
        rule: BLANKET_BASH_ALLOW,
        path: SETTINGS,
        what: "a git allow, which neither reads files nor runs a shell",
      },
    ],
  }),

  // Two other AI tools beside an AGENTS.md, and a placeholder AWS key; no Claude Code.
  repo("mobile-app", {
    files: [
      { path: "AGENTS.md", text: "# Agents\n\nRun the linter first.\n" },
      { path: ".github/copilot-instructions.md", text: "Use Kotlin coroutines.\n" },
      { path: "GEMINI.md", text: "Answer in British English.\n" },
      {
        path: "app/src/aws.kt",
        text: 'const val AWS_ACCESS_KEY_ID = "AKIAXXXXXXXXXXXXXXXX"\n',
      },
    ],
    labels: [
      { rule: UNAPPROVED_AI_TOOL, path: ".github/copilot-instructions.md" },
      { rule: UNAPPROVED_AI_TOOL, path: ".gemini" },
    ],
    nearMisses: [
      {
        rule: SECRET_IN_REPO,
        path: "app/src/aws.kt",
        what: "a placeholder AWS key in a source file",
      },
    ],
  }),

  // A Stripe key in the server, and a bash -c allow in a package's own settings.
  repo("web-store", {
    files: [
      CLAUDE_MD,
      json(SETTINGS, { permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env*)"] } }),
      json("packages/web/.claude/settings.json", {
        permissions: { allow: ["Bash(bash -c:*)"] },
      }),
      {
        path: "server/payments.ts",
        text: `import Stripe from "stripe";\n\nexport const stripe = new Stripe("${STRIPE_KEY}");\n`,
      },
    ],
    labels: [
      { rule: SECRET_IN_REPO, path: "server/payments.ts" },
      { rule: BLANKET_BASH_ALLOW, path: "packages/web/.claude/settings.json" },
    ],
    nearMisses: [{ rule: AGENT_CAN_READ_ENV, path: SETTINGS, what: "a Read(./.env*) deny" }],
  }),

  // A CLAUDE.md and nothing else of Claude Code's, and a Makefile target that skips the checks.
  repo("infra", {
    files: [
      CLAUDE_MD,
      { path: "Makefile", text: `plan:\n\tterraform plan\n\nagent:\n\tclaude ${FLAG}\n` },
      {
        path: "docs/agents.md",
        text: `# Agents\n\nThe \`agent\` target runs \`claude ${FLAG}\`; use it only in a throwaway VM.\n`,
      },
      { path: "main.tf", text: 'provider "google" {\n  region = "europe-west1"\n}\n' },
    ],
    labels: [
      { rule: AGENT_CAN_READ_ENV, path: SETTINGS },
      { rule: NO_RUNTIME_GUARD, path: SETTINGS },
      { rule: PERMISSION_SKIP, path: "Makefile" },
    ],
    nearMisses: [
      { rule: PERMISSION_SKIP, path: "docs/agents.md", what: "the skip flag in a Markdown doc" },
    ],
  }),
];
