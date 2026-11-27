// Guard's two secret Rules (Guard spec, story 3): a secret committed to a repo, and one in an agent settings file.
// Nine secret types, each a fixed pattern; no entropy guessing, to keep false positives down. A secret's value never
// leaves this file: each is answered as its type, place and mask, which shows its first 4 characters and never its
// length.
import type { Asset, Observation, SecretEvidence } from "@warden/contracts";
import { packRule, SECRET_IN_AGENT_SETTINGS, SECRET_IN_REPO } from "./default-pack.ts";
import type { RepoFile } from "./repo-reader.ts";

/**
 * Each secret type and its pattern. The lookbehinds and lookaheads keep a match from starting or ending inside a
 * longer word; the upper bounds keep a match to a token's size. A `body` group holds what follows the type's fixed
 * prefix, where it has one. A type with an `end` is a block: `maskSecrets` masks from the match through the line
 * `end` names, or to the text's end without one, while `findSecrets` answers the match alone.
 */
const SECRET_TYPES: readonly {
  type: string;
  pattern: RegExp;
  end?: (match: RegExpExecArray) => string;
}[] = [
  {
    type: "AWS access key id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)(?<body>[A-Z0-9]{16})(?![A-Za-z0-9])/g,
  },
  {
    type: "GitHub token",
    pattern:
      /(?<![A-Za-z0-9_])(?:gh[pousr]_(?<body>[A-Za-z0-9]{36,251})|github_pat_[A-Za-z0-9_]{36,244})(?![A-Za-z0-9_])/g,
  },
  {
    type: "private key",
    pattern: /-----BEGIN (?<label>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g,
    end: (match) => `-----END ${match.groups?.label}-----`,
  },
  {
    type: "Stripe live secret key",
    pattern: /(?<![A-Za-z0-9_])sk_live_(?<body>[A-Za-z0-9]{24,247})(?![A-Za-z0-9])/g,
  },
  { type: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abeoprs]-(?<body>[A-Za-z0-9-]{10,250})/g },
  { type: "Anthropic key", pattern: /(?<![A-Za-z0-9_-])sk-ant-(?<body>[A-Za-z0-9_-]{32,250})/g },
  { type: "OpenRouter key", pattern: /(?<![A-Za-z0-9_-])sk-or-v1-(?<body>[A-Za-z0-9]{32,250})/g },
  {
    // A project, service account or admin key, or the older kind with `T3BlbkFJ` in the middle.
    type: "OpenAI key",
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-(?<body>[A-Za-z0-9_-]{20,250})|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  },
  {
    type: "Google API key",
    pattern: /(?<![A-Za-z0-9_-])AIza(?<body>[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g,
  },
];

/** A placeholder's word: `your`, `here`, `placeholder` or a run of `x`, standing alone between non-letters. */
const PLACEHOLDER_WORD = /(?:^|[^a-z0-9])(?:your|here|placeholder|x{4,})(?:[^a-z0-9]|$)/i;

/**
 * A match that is a placeholder from docs or a template, not a secret: it says `example`, holds a placeholder word,
 * or its body, separators aside, is one character repeated.
 */
function isPlaceholder(value: string, body: string | undefined): boolean {
  return (
    /example/i.test(value) ||
    PLACEHOLDER_WORD.test(value) ||
    (body !== undefined && /^(.)\1*$/.test(body.replace(/[-_]/g, "")))
  );
}

/** The first 4 characters, then 8 `*` whatever the length, so the mask never tells how long the secret is. */
const mask = (secret: string) => `${secret.slice(0, 4)}********`;

/** One secret in a text: its type, where it starts and ends, and its value. */
type SecretMatch = { type: string; start: number; end: number; value: string };

/**
 * Each secret in `text`, in the order they appear, placeholders left out. Where two patterns match the same text,
 * the earlier match is kept. With `blocks`, a block type's match runs on through its end line (or to the text's
 * end), and nothing inside it is answered on its own.
 */
function secretsIn(text: string, { blocks }: { blocks: boolean }): SecretMatch[] {
  const matches = SECRET_TYPES.flatMap(({ type, pattern, end }) =>
    Array.from(text.matchAll(pattern))
      .filter((match) => !isPlaceholder(match[0], match.groups?.body))
      .map((match) => ({
        type,
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        endLine: blocks ? end?.(match) : undefined,
      })),
  ).sort((a, b) => a.start - b.start);
  const kept: SecretMatch[] = [];
  let end = 0;
  for (const { endLine, ...match } of matches) {
    if (match.start < end) continue;
    if (endLine !== undefined) {
      const at = text.indexOf(endLine, match.end);
      match.end = at === -1 ? text.length : at + endLine.length;
    }
    end = match.end;
    kept.push(match);
  }
  return kept;
}

/**
 * Each secret in a file's text, in the order they appear: its type, the file's path, its line (from 1) and its mask,
 * as `SecretEvidence` takes it. Never the value. Placeholders are left out. Where two patterns match the same text,
 * the earlier match is kept.
 */
export function findSecrets(path: string, text: string): SecretEvidence[] {
  return text.split("\n").flatMap((content, i) =>
    secretsIn(content, { blocks: false }).map((match) => ({
      type: match.type,
      path,
      line: i + 1,
      mask: mask(match.value),
    })),
  );
}

/**
 * `text` with each secret replaced by its mask, as `findSecrets` gives it, and placeholders left as they are. A
 * private key is masked as a whole block, from its BEGIN line through its matching END line, or to the text's end
 * when there's none, so the key's body never stays behind its masked header.
 */
export function maskSecrets(text: string): string {
  let masked = "";
  let from = 0;
  for (const match of secretsIn(text, { blocks: true })) {
    masked += text.slice(from, match.start) + mask(match.value);
    from = match.end;
  }
  return masked + text.slice(from);
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
