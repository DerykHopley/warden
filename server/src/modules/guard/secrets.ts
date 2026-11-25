// Guard's two secret Rules (Guard spec, story 3): a secret committed to a repo, and one in an agent settings file.
// Nine secret types, each a fixed pattern; no entropy guessing, to keep false positives down. A secret's value never
// leaves this file: each is answered as its type, place and mask, which shows its first 4 characters and never its
// length.
import type { Asset, Observation, SecretEvidence } from "@warden/contracts";
import { packRule, SECRET_IN_AGENT_SETTINGS, SECRET_IN_REPO } from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";

/**
 * Each secret type and its pattern. The lookbehinds and lookaheads keep a match from starting or ending inside a
 * longer word; the upper bounds keep a match to a token's size.
 */
const SECRET_TYPES: readonly { type: string; pattern: RegExp }[] = [
  {
    type: "AWS access key id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  {
    type: "GitHub token",
    pattern:
      /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{36,244})(?![A-Za-z0-9_])/g,
  },
  { type: "private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  {
    type: "Stripe live secret key",
    pattern: /(?<![A-Za-z0-9_])sk_live_[A-Za-z0-9]{24,247}(?![A-Za-z0-9])/g,
  },
  { type: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,250}/g },
  { type: "Anthropic key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{32,250}/g },
  { type: "OpenRouter key", pattern: /(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9]{32,250}/g },
  {
    // A project, service account or admin key, or the older kind with `T3BlbkFJ` in the middle.
    type: "OpenAI key",
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,250}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  },
  {
    type: "Google API key",
    pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  },
];

/** The first 4 characters, then 8 `*` whatever the length, so the mask never tells how long the secret is. */
const mask = (secret: string) => `${secret.slice(0, 4)}********`;

/**
 * Each secret in a file's text, in the order they appear: its type, the file's path, its line (from 1) and its mask,
 * as `SecretEvidence` takes it. Never the value. Where two patterns match the same text, the earlier match is kept.
 */
export function findSecrets(path: string, text: string): SecretEvidence[] {
  const found: SecretEvidence[] = [];
  text.split("\n").forEach((content, i) => {
    const matches = SECRET_TYPES.flatMap(({ type, pattern }) =>
      Array.from(content.matchAll(pattern), (match) => ({
        type,
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      })),
    ).sort((a, b) => a.start - b.start);
    let end = 0;
    for (const match of matches) {
      if (match.start < end) continue;
      end = match.end;
      found.push({ type: match.type, path, line: i + 1, mask: mask(match.value) });
    }
  });
  return found;
}

/** An agent's settings file: `.claude/settings.json` or `.claude/settings.local.json` in any folder, or `.mcp.json`. */
export function isAgentSettingsFile(path: string): boolean {
  return /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.mcp\.json)$/.test(path);
}

/**
 * What one file's secrets come to: none, or one Observation under the Rule its path calls for. A Fingerprint leaves
 * out the line, so the file's secrets share one: the Location and the evidence's secret are the first one's, and the
 * summary counts them all, names their types and ends with the Pack's fix.
 */
export function secretObservations(asset: Asset, { path, text }: RepoFile): Observation[] {
  const secrets = findSecrets(path, text);
  const [first] = secrets;
  if (first === undefined) return [];
  const rule = packRule(isAgentSettingsFile(path) ? SECRET_IN_AGENT_SETTINGS : SECRET_IN_REPO);
  const count = secrets.length;
  const types = [...new Set(secrets.map((secret) => secret.type))].join(", ");
  const where = count === 1 ? `on line ${first.line}` : `first on line ${first.line}`;
  return [
    {
      asset,
      rule_id: rule.ruleId,
      location: { kind: "file", path, line: first.line },
      severity: rule.severity,
      title: rule.title,
      evidence: {
        summary: `${count} ${count === 1 ? "secret" : "secrets"} (${types}) in ${path}, ${where}. To fix: ${rule.fix}`,
        secret: first,
      },
    },
  ];
}
