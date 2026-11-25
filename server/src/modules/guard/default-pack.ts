// The Default Pack (GLOSSARY: Pack), as data: the Rules a Guard Scan checks at Quick, each with its Severity, the
// title a Finding shows, and a one-line fix. The fix goes in the evidence summary, as a new Finding field would change
// the Finding format. Slices 4b and 5 add the other four Rules.
import type { RuleId, Severity } from "@warden/contracts";

export type PackRule = {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  /** What to do about it, in one line: the last sentence of each Finding's evidence summary. */
  fix: string;
};

export const SECRET_IN_REPO = "guard/secret-in-repo";
export const SECRET_IN_AGENT_SETTINGS = "guard/secret-in-agent-settings";
export const BLANKET_BASH_ALLOW = "guard/blanket-bash-allow";
export const PERMISSION_SKIP = "guard/permission-skip";

export const DEFAULT_PACK: readonly PackRule[] = [
  {
    ruleId: SECRET_IN_REPO,
    severity: "high",
    title: "A secret is committed to the repo",
    fix: "Revoke and rotate the secret, then remove it from the file and from the repo's history.",
  },
  {
    ruleId: SECRET_IN_AGENT_SETTINGS,
    severity: "high",
    title: "A secret sits in an agent settings file",
    fix: "Revoke and rotate the secret, then move it to an environment variable the agent's settings refer to.",
  },
  {
    ruleId: BLANKET_BASH_ALLOW,
    severity: "high",
    title: "A broad Bash allow gets round the agent's deny rules",
    fix: "Replace each broad Bash allow with the exact commands the agent needs.",
  },
  {
    ruleId: PERMISSION_SKIP,
    severity: "high",
    title: "The agent is set to skip its permission checks",
    fix: "Remove the flag or setting, so the agent asks before each risky tool call.",
  },
];

/** The Pack's entry for a Rule; throws for a Rule it doesn't have. */
export function packRule(ruleId: RuleId): PackRule {
  const entry = DEFAULT_PACK.find((rule) => rule.ruleId === ruleId);
  if (entry === undefined) throw new Error(`the Default Pack has no Rule ${ruleId}`);
  return entry;
}
