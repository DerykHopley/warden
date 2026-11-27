// A Team's judged Controls with their Verdicts (spec #341, slice 2b, stories 2 and 3): the Team's held Assets, Open
// Findings, coverage and Judge Spot run in the last 30 days, read once, and `workOutVerdict` per Control. Worked out on
// read, never stored. Every read goes through `findings` under `withTeam`, so a Team sees only its own (story 10).
import type { ControlEvidence, ControlVerdict, Finding, RuleId } from "@warden/contracts";
import { OVERVIEW_PERIOD_DAYS, type Findings } from "../../findings/index.ts";
import type { Catalogue, Control } from "./catalogue.ts";
import type { VouchDeps } from "./deps.ts";
import { reviewedOn, withReviewState } from "./review-state.ts";
import { JUDGE_SPOT_RUN_CONTROLS, RULE_CONTROLS } from "./rule-controls.ts";
import type { TeamAssets } from "./team-assets.ts";
import { kindOf, workOutVerdict, type WorkedOutVerdict } from "./verdict.ts";

/** The Findings reads a Control's Verdict needs, and nothing that writes. */
export type VouchReads = Pick<Findings, "listByRules" | "coverageSince" | "lastSpotRunAt">;

/** A judged Control with its worked-out Verdict, reason and evidence: what the API answers, before its reviews join. */
export type JudgedControl = Omit<ControlVerdict, "review_state" | "reviewed_verdict">;

const DAY = 24 * 3600_000;

/** The Rules that evidence Control `ref`, in `RULE_CONTROLS`' order. */
const rulesOf = (ref: string): RuleId[] =>
  Object.entries(RULE_CONTROLS)
    .filter(([, refs]) => refs.includes(ref))
    .map(([rule]) => rule);

/** Each of `controls`, in the order given, with its Verdict, reason and evidence for `team` as of `now`. */
export async function judgeControls(
  { findings, teamAssets }: { findings: VouchReads; teamAssets: TeamAssets },
  team: string,
  controls: readonly Control[],
  now: Date,
): Promise<JudgedControl[]> {
  const since = new Date(now.getTime() - OVERVIEW_PERIOD_DAYS * DAY);
  const rules = [...new Set(controls.flatMap(({ id }) => rulesOf(id)))];
  const spotRun = controls.some(({ id }) => JUDGE_SPOT_RUN_CONTROLS.includes(id));

  const held = await teamAssets.held(team);
  const open = await findings.listByRules(team, { rules, statuses: ["open"] });
  const coverage = await findings.coverageSince(team, { rules, since });
  // The Judge writes its Spot runs as Guard (#357), and nothing else in Guard sends one.
  const lastRunAt = spotRun ? await findings.lastSpotRunAt(team, { module: "guard", since }) : null;

  return controls.map((control) => {
    const worked = JUDGE_SPOT_RUN_CONTROLS.includes(control.id)
      ? workOutVerdict({ kind: "judge_spot_run", last_run_at: lastRunAt, now })
      : workOutVerdict({
          kind: "rules",
          rules: rulesOf(control.id).map((rule_id) => ({
            rule_id,
            held: held[kindOf(rule_id)],
            coverage: coverage.filter((entry) => entry.rule_id === rule_id),
            findings: open.filter((finding) => finding.rule_id === rule_id),
          })),
          now,
        });
    return {
      ref: control.id,
      question: control.question,
      iso_27001: control.iso_27001,
      verdict: worked.verdict,
      reason: worked.reason,
      evidence: evidenceOf(worked, open),
    };
  });
}

/**
 * Each of `catalogue`'s judged Controls, in its order, judged for `team` as of `now`, with its review state from its
 * newest review: what `GET /api/vouch/catalogues/:id/controls` lists, and what the Overview's answer reads.
 */
export async function judgeCatalogue(
  {
    findings,
    teamAssets,
    controlReviews,
  }: Pick<VouchDeps, "findings" | "teamAssets" | "controlReviews">,
  team: string,
  catalogue: Catalogue,
  now: Date,
): Promise<ControlVerdict[]> {
  const judged = await judgeControls({ findings, teamAssets }, team, catalogue.judgedControls, now);
  // Only each Control's newest review counts for its review state, so only those are read.
  const newest = await controlReviews.newest(team, catalogue.id);
  return judged.map((control) => {
    const review = newest.find(({ controlRef }) => controlRef === control.ref);
    return withReviewState(control, review === undefined ? [] : [reviewedOn(review)]);
  });
}

/** The evidence behind `worked`, its Open Findings taken from `open` (the Team's, ordered by id). */
function evidenceOf(worked: WorkedOutVerdict, open: readonly Finding[]): ControlEvidence {
  if (worked.kind === "judge_spot_run") {
    return { rules: [], judge_spot_run_at: worked.last_run_at, open_findings: [] };
  }
  return {
    rules: worked.rules.map((rule) => ({
      rule_id: rule.rule_id,
      asset_kind: kindOf(rule.rule_id),
      last_covered_at: rule.last_covered_at,
      assets_covered: rule.covered.length,
      assets_held: rule.held.length,
    })),
    judge_spot_run_at: null,
    // Only the Open Findings that count against the Verdict: those on an Asset the Team holds now.
    open_findings: worked.rules.flatMap((rule) =>
      open
        .filter((finding) => rule.open.includes(finding.id))
        .map(({ id, rule_id, title, severity, asset }) => ({
          id,
          rule_id,
          title,
          severity,
          asset,
        })),
    ),
  };
}
