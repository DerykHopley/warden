// The Verdict (spec #341, story 2): one judged Control's Verdict, worked out on read and never stored. Pure: no
// database, no clock of its own, no model call. The caller reads the Team's held Assets, coverage, Findings and Judge
// Spot run, and hands them in with `now`.
//
// Each Rule is judged first, on the Team's Assets of its kind held now; the Control rolls up from its Rules as the
// original Vouch's `roll_up` does (tc-vouch-compliance, graph.py at 2a71465). Severity doesn't change it.
import type { Asset, Finding, RuleId, Verdict } from "@warden/contracts";
import { OVERVIEW_PERIOD_DAYS, type CoverageEntry } from "../../findings/index.ts";

const DAY = 24 * 3600_000;

/** The kinds of Asset a Rule is judged on: a `guard/` Rule on Repos, a `patch/` Rule on Products. */
export type JudgedKind = "repo" | "product";

/** What the Verdict reads from a Finding: which, where, and its Status. */
export type VerdictFinding = Pick<Finding, "id" | "asset" | "status">;

/** One of a Control's Rules (`RULE_CONTROLS`), with what the Team has under it. */
export interface RuleEvidence {
  rule_id: RuleId;
  /** The refs of the Team's Assets of the Rule's kind, held now. */
  held: readonly string[];
  /** The Rule's coverage entries (`Findings.coverageSince`). Only those on a held Asset of its kind count. */
  coverage: readonly CoverageEntry[];
  /** The Team's Findings under the Rule. Only Open ones on a held Asset of its kind count against it. */
  findings: readonly VerdictFinding[];
}

/** One judged Control's evidence: its Rules, or, for a Control in `JUDGE_SPOT_RUN_CONTROLS`, its newest Judge Spot run. */
export type VerdictInput =
  | { kind: "rules"; rules: readonly RuleEvidence[]; now: Date }
  | { kind: "judge_spot_run"; last_run_at: string | null; now: Date };

/** One Rule's own Verdict and the evidence behind it. */
export interface RuleVerdict {
  rule_id: RuleId;
  verdict: Verdict;
  /** The newest coverage on a held Asset of the Rule's kind, in the 30 days or before; null when none. */
  last_covered_at: string | null;
  /** The held Assets covered in the 30 days, in `held`'s order. */
  covered: string[];
  held: string[];
  /** The ids of the Open Findings that count against the Rule. */
  open: string[];
}

/** A judged Control's worked-out Verdict, its one-line reason, and the evidence behind it. */
export type WorkedOutVerdict = { verdict: Verdict; reason: string } & (
  { kind: "rules"; rules: RuleVerdict[] } | { kind: "judge_spot_run"; last_run_at: string | null }
);

/** All evidenced gives evidenced; none evidenced (only partly or not) gives not evidenced; any other mix, partly. */
export function rollUp(verdicts: readonly Verdict[]): Verdict {
  const evidenced = verdicts.filter((verdict) => verdict === "evidenced").length;
  if (evidenced === 0) return "not_evidenced";
  return evidenced === verdicts.length ? "evidenced" : "partly_evidenced";
}

export function workOutVerdict(input: VerdictInput): WorkedOutVerdict {
  const since = input.now.getTime() - OVERVIEW_PERIOD_DAYS * DAY;
  const inPeriod = (at: string) => Date.parse(at) >= since;

  if (input.kind === "judge_spot_run") {
    const { last_run_at } = input;
    const ran = last_run_at !== null && inPeriod(last_run_at);
    return {
      verdict: ran ? "evidenced" : "not_evidenced",
      reason: ran
        ? `Judge Spot run on ${last_run_at.slice(0, 10)}`
        : `No Judge Spot run in the last ${OVERVIEW_PERIOD_DAYS} days`,
      kind: "judge_spot_run",
      last_run_at,
    };
  }

  const judged = input.rules.map((evidence) => judgeRule(evidence, inPeriod));
  return {
    verdict: rollUp(judged.map(({ rule }) => rule.verdict)),
    reason: reasonFor(judged),
    kind: "rules",
    rules: judged.map(({ rule }) => rule),
  };
}

/** A Rule's kind, from its module. Vouch judges only Guard's and Patch's Rules by their Assets. */
export function kindOf(rule: RuleId): JudgedKind {
  if (rule.startsWith("guard/")) return "repo";
  if (rule.startsWith("patch/")) return "product";
  throw new Error(`${rule}: Vouch judges only guard/ and patch/ Rules on Assets`);
}

interface JudgedRule {
  rule: RuleVerdict;
  kind: JudgedKind;
  /** The Assets the Open Findings that count are on. */
  openAssets: Asset[];
}

function judgeRule(evidence: RuleEvidence, inPeriod: (at: string) => boolean): JudgedRule {
  const kind = kindOf(evidence.rule_id);
  const held = [...evidence.held];
  const isHeld = (asset: Asset) => asset.kind === kind && held.includes(asset.ref);

  const lastCovered = new Map<string, string>();
  for (const entry of evidence.coverage) {
    if (entry.rule_id !== evidence.rule_id || !isHeld(entry.asset)) continue;
    const earlier = lastCovered.get(entry.asset.ref);
    if (earlier === undefined || Date.parse(entry.last_covered_at) > Date.parse(earlier)) {
      lastCovered.set(entry.asset.ref, entry.last_covered_at);
    }
  }
  const newest = [...lastCovered.values()].sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const covered = held.filter((ref) => {
    const at = lastCovered.get(ref);
    return at !== undefined && inPeriod(at);
  });
  const open = evidence.findings.filter(
    (finding) => finding.status === "open" && isHeld(finding.asset),
  );

  let verdict: Verdict = "evidenced";
  if (covered.length === 0) verdict = "not_evidenced";
  else if (open.length > 0 || covered.length < held.length) verdict = "partly_evidenced";

  return {
    rule: {
      rule_id: evidence.rule_id,
      verdict,
      last_covered_at: newest ?? null,
      covered,
      held,
      open: open.map((finding) => finding.id),
    },
    kind,
    openAssets: open.map((finding) => finding.asset),
  };
}

const NOUN: Record<JudgedKind, [one: string, many: string]> = {
  repo: ["Repo", "Repos"],
  product: ["Product", "Products"],
};
const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
const KINDS: readonly JudgedKind[] = ["repo", "product"];

/** The reason: one line from the same facts as the Verdict, its parts joined with "; ". */
function reasonFor(judged: readonly JudgedRule[]): string {
  const period = `in the last ${OVERVIEW_PERIOD_DAYS} days`;
  if (judged.every(({ rule }) => rule.covered.length === 0)) return `No Scan ${period}`;

  const kinds = KINDS.filter((kind) => judged.some((rule) => rule.kind === kind));
  const parts: string[] = [];

  const open = judged.flatMap(({ openAssets }) => openAssets);
  if (open.length > 0) {
    const on = kinds.flatMap((kind) => {
      const assets = new Set(open.filter((asset) => asset.kind === kind).map((asset) => asset.ref));
      return assets.size === 0 ? [] : [count(assets.size, NOUN[kind])];
    });
    parts.push(`${count(open.length, ["Open Finding", "Open Findings"])} on ${on.join(" and ")}`);
  }

  const notScanned: string[] = [];
  const noneHeld: string[] = [];
  for (const kind of kinds) {
    const rules = judged.filter((rule) => rule.kind === kind).map(({ rule }) => rule);
    const held = new Set(rules.flatMap((rule) => rule.held));
    if (held.size === 0) {
      noneHeld.push(NOUN[kind][1]);
      continue;
    }
    // An Asset is scanned when every one of the Control's Rules of its kind covered it.
    const missed = [...held].filter((ref) => rules.some((rule) => !rule.covered.includes(ref)));
    if (missed.length > 0) notScanned.push(`${missed.length} of ${count(held.size, NOUN[kind])}`);
  }
  if (notScanned.length > 0) parts.push(`${notScanned.join(" and ")} not scanned ${period}`);
  if (noneHeld.length > 0) parts.push(`No ${noneHeld.join(" or ")} to scan`);

  if (parts.length > 0) return parts.join("; ");
  return `Every ${kinds.map((kind) => NOUN[kind][0]).join(" and ")} scanned ${period}, nothing Open`;
}
