// The Judge eval's report (spec #225, story 17; slice 13a): the saved runs as one Markdown page, `docs/eval/report.md`.
// What each run changed and why is written in the run list, `docs/eval/runs.json` (`ReportRuns`); every number comes
// from the results files through `scoreResults` and `findRegressions`. `renderReport` is pure and holds no render
// time, so the same inputs give the same bytes; `eval:report` (`report-cli.ts`) reads the files and writes the page.
import { z } from "zod";
import { CASE_GROUPS, CASE_SPLITS, type EvalCase, type EvalTargets } from "./eval-cases.ts";
import { findRegressions } from "./regressions.ts";
import { latestResults, modelKey, resultKey, type EvalResultLine } from "./results.ts";
import { scoreResults, scoreTable, type ModelScore, type TargetsMet } from "./score.ts";
import type { EvalSplit } from "./settings.ts";

/** A results file's name in the `results/` folder beside the run list: no folder in it, and no way out of it. */
const ResultsName = z
  .string()
  .min(1)
  .refine((name) => !/[/\\]/.test(name) && !name.includes(".."), {
    message: "isn't a plain file name in results/: it holds a / or ..",
  });

/** Markdown blocks, each a paragraph or a list, shown a blank line apart. */
const Paragraphs = z.array(z.string().min(1));

const IssueNumber = z.number().int().positive();

const ReportRun = z.strictObject({
  name: z.string().min(1),
  /** The run's results file. */
  results: ResultsName,
  /** The files its flips were run again into, once each: possibly none. */
  flip_reruns: z.array(ResultsName),
  /** The short sha the run judged with. */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/, { message: "isn't a git sha" }),
  /** What changed since the previous run; null for the baseline. */
  change: z
    .strictObject({
      title: z.string().min(1),
      why: z.string().min(1),
      issues: z.array(IssueNumber),
      prs: z.array(IssueNumber),
    })
    .nullable(),
  model_kept: z.string().min(1),
  /** Whether the change was kept; null for the baseline. */
  change_kept: z.boolean().nullable(),
  /** The causes of the run's failures. */
  notes: Paragraphs,
});

/** `docs/eval/runs.json`: the case set's "why", and each run in the order it ran. */
export const ReportRuns = z.strictObject({
  about: Paragraphs.min(1),
  runs: z
    .array(ReportRun)
    .min(1, { message: "holds no run" })
    .superRefine((runs, context) =>
      runs.forEach(({ name }, i) => {
        if (runs.findIndex((run) => run.name === name) !== i)
          context.addIssue({
            code: "custom",
            path: [i, "name"],
            message: `repeats the run name "${name}"`,
          });
      }),
    ),
});

export type ReportRuns = z.infer<typeof ReportRuns>;
type ReportRun = ReportRuns["runs"][number];

export type ReportInputs = {
  runs: ReportRuns;
  /** Each results file the run list names, by its name, with its lines as saved. */
  results: ReadonlyMap<string, readonly EvalResultLine[]>;
  cases: readonly EvalCase[];
  targets: EvalTargets;
};

/** Where an issue or PR number links to. */
const REPO_URL = "https://github.com/DerykHopley/warden";

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const tableRow = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
  [tableRow(head), tableRow(head.map(() => "---")), ...rows.map(tableRow)].join("\n");

const fixed = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));
const usd = (value: number | null) =>
  value === null ? "-" : `$${value.toFixed(value === 0 ? 2 : 4)}`;
const metText = (met: boolean | null) => (met === null ? "n/a" : met ? "met" : "**missed**");
const ruleList = (rules: readonly string[]) => (rules.length === 0 ? "none" : rules.join(", "));

/** Each target's threshold in words: a target added to `targets.json` won't compile until it has one. */
const THRESHOLDS: { [Target in keyof TargetsMet]: (targets: EvalTargets) => string } = {
  high_rule_recall: ({ high_rule_recall: t }) =>
    `at least ${t.at_least} on each of ${t.rules.join(", ")}`,
  precision: ({ precision: t }) => `at least ${t.at_least}`,
  ordinary_flagged: ({ ordinary_flagged: t }) => `at most ${t.at_most}`,
  injection: ({ injection: t }) =>
    `${t.rule} flagged on ${t.flagged}, ${t.marked_clean} marked clean`,
  cost_per_session_usd: ({ cost_per_session_usd: t }) =>
    `under $${t.under} a session, paid models only`,
};
const TARGET_KEYS = Object.keys(THRESHOLDS) as (keyof TargetsMet)[];

/** A run with its lines and its score per model. */
type Scored = { run: ReportRun; lines: readonly EvalResultLine[]; scores: ModelScore[] };

const splitOf = (score: ModelScore, split: EvalSplit) =>
  score.splits.find((one) => one.split === split)!;

function linesOf(results: ReportInputs["results"], name: string): readonly EvalResultLine[] {
  const lines = results.get(name);
  if (lines === undefined) throw new Error(`no results given for ${name}`);
  return lines;
}

function caseSet(about: readonly string[], cases: readonly EvalCase[]): string {
  const count = (group?: string, split?: string) =>
    cases.filter(
      (c) =>
        (group === undefined || c.group === group) && (split === undefined || c.split === split),
    ).length;
  const counts = (group?: string) => [
    group ?? "all",
    ...CASE_SPLITS.map((split) => String(count(group, split))),
    String(count(group)),
  ];
  return [
    "## Case set and why",
    ...about,
    table(["Group", ...CASE_SPLITS, "all"], [...CASE_GROUPS.map(counts), counts()]),
    "Each case by name. The report shows no event text, so no fixture secret appears in it.",
    table(
      ["Case", "Group", "Split", "Tier", "Labels", "Stands for", "Source", "Length"],
      cases.map((c) => [
        c.name,
        c.group,
        c.split,
        c.tier,
        c.labels.length === 0 ? "clean" : c.labels.join(", "),
        c.stands_for,
        c.source,
        c.length ?? "-",
      ]),
    ),
  ].join("\n\n");
}

function criteria(targets: EvalTargets): string {
  return [
    "## Criteria",
    targets.description,
    table(
      ["Target", "What it measures", "Threshold"],
      TARGET_KEYS.map((key) => [key, targets[key].description, THRESHOLDS[key](targets)]),
    ),
  ].join("\n\n");
}

function summary(scored: readonly Scored[]): string {
  return [
    "## Summary",
    "Each run and model: the dev and held-out cases passed and their precision, then each target on every case.",
    table(
      [
        "Run",
        "Model",
        "Dev passed",
        "Held-out passed",
        "Dev precision",
        "Held-out precision",
        ...TARGET_KEYS,
      ],
      scored.flatMap(({ run, scores }) =>
        scores.map((score) => {
          const [dev, heldOut, all] = [
            splitOf(score, "dev"),
            splitOf(score, "held-out"),
            splitOf(score, "all"),
          ];
          return [
            run.name,
            score.model,
            `${dev.passed}/${dev.run}`,
            `${heldOut.passed}/${heldOut.run}`,
            fixed(dev.precision),
            fixed(heldOut.precision),
            ...TARGET_KEYS.map((key) => metText(all.targets[key])),
          ];
        }),
      ),
    ),
  ].join("\n\n");
}

const links = (numbers: readonly number[], kind: "issues" | "pull") =>
  numbers.length === 0
    ? "none"
    : numbers.map((number) => `[#${number}](${REPO_URL}/${kind}/${number})`).join(", ");

function runSection({ run, lines, scores }: Scored): string {
  const change =
    run.change === null
      ? ["**Change:** no change."]
      : [
          `**Change:** ${run.change.title}`,
          run.change.why,
          `**Issues:** ${links(run.change.issues, "issues")}. **PRs:** ${links(run.change.prs, "pull")}.`,
        ];
  const latest = latestResults(lines);
  const failing = scores.flatMap((score) =>
    latest
      .filter((line) => !line.pass && modelKey(line) === modelKey(score))
      .map((line) => [
        line.model,
        line.case,
        line.split,
        ruleList(line.missing),
        ruleList(line.extra),
        line.error ?? "-",
      ]),
  );
  const kept = run.change_kept === null ? "no change to keep" : run.change_kept ? "yes" : "no";
  return [
    `## Run: ${run.name}`,
    `**Commit:** \`${run.commit}\``,
    ...change,
    "### Scores",
    "As `eval:score` prints them from the run's results file.",
    `\`\`\`text\n${scoreTable(scores)}\n\`\`\``,
    "### Failing cases",
    failing.length === 0
      ? "No case failed."
      : table(["Model", "Case", "Split", "Missing", "Extra", "Error"], failing),
    "### Notes",
    ...run.notes,
    `**Model kept:** \`${run.model_kept}\`. **Change kept:** ${kept}.`,
  ].join("\n\n");
}

/** Each (model, case)'s latest line in `lines`, by `resultKey`. */
const latestByKey = (lines: readonly EvalResultLine[]) =>
  new Map(latestResults(lines).map((line) => [resultKey(line), line]));

function regressionsBetween(
  earlier: Scored,
  later: Scored,
  results: ReportInputs["results"],
): string[] {
  const found = findRegressions(earlier.lines, later.lines);
  const laterLines = latestByKey(later.lines);
  const reruns = latestByKey(later.run.flip_reruns.flatMap((name) => linesOf(results, name)));
  const parts = [`### ${earlier.run.name} to ${later.run.name}`];
  for (const { provider, model, flips, notInBoth } of found.models) {
    if (flips.length === 0) parts.push(`\`${model}\`: no case broke.`);
    else
      parts.push(
        `\`${model}\`: ${flips.length} case${flips.length === 1 ? "" : "s"} broke.`,
        table(
          ["Model", "Case", "Split", "Lost", "Gained", "Error", "Verdict"],
          flips.map((flip) => {
            const key = resultKey({ provider, model, case: flip.case });
            const rerun = reruns.get(key);
            const verdict = rerun === undefined ? "not rerun" : rerun.pass ? "noise" : "confirmed";
            return [
              model,
              flip.case,
              laterLines.get(key)!.split,
              ruleList(flip.missing),
              ruleList(flip.extra),
              flip.error ?? "-",
              `**${verdict}**`,
            ];
          }),
        ),
      );
    if (notInBoth.length > 0)
      parts.push(
        `\`${model}\` ran these in only one of the two runs: ${notInBoth
          .map((one) => `${one.case} (${one.in === "earlier" ? earlier.run.name : later.run.name})`)
          .join(", ")}.`,
      );
  }
  for (const { model, in: file } of found.onlyIn)
    parts.push(
      `\`${model}\`: only in ${file === "earlier" ? earlier.run.name : later.run.name}, so nothing to compare.`,
    );
  return parts;
}

function regressions(scored: readonly Scored[], results: ReportInputs["results"]): string {
  const pairs = scored.slice(1).map((later, i) => regressionsBetween(scored[i]!, later, results));
  return [
    "## Regressions",
    "Each case that passed in the previous run and fails in this one, per model (`eval:regressions`). A flip run " +
      "again once into one of the run's `flip_reruns` files reads **noise** when that rerun passed and " +
      "**confirmed** when it failed; with no rerun, it reads **not rerun**.",
    ...(pairs.length === 0 ? ["One run so far: nothing to compare."] : pairs.flat()),
  ].join("\n\n");
}

function heldOutScore(scored: readonly Scored[]): string {
  return [
    "## Held-out score",
    "Held-out cases chose no change: each change was made from the dev cases' failures only, so the held-out " +
      "score shows whether it carries over to cases it wasn't made from.",
    table(
      ["Run", "Model", "Held-out passed", "Held-out precision"],
      scored.flatMap(({ run, scores }) =>
        scores.map((score) => {
          const heldOut = splitOf(score, "held-out");
          return [
            run.name,
            score.model,
            `${heldOut.passed}/${heldOut.run}`,
            fixed(heldOut.precision),
          ];
        }),
      ),
    ),
  ].join("\n\n");
}

function cost(scored: readonly Scored[]): string {
  return [
    "## Cost",
    "Each run and model, over every case. A local model runs on the owner's machine and costs nothing.",
    table(
      [
        "Run",
        "Model",
        "Provider",
        "Total cost",
        "Cost per session",
        "Input tokens per session",
        "Output tokens per session",
      ],
      scored.flatMap(({ run, scores }) =>
        scores.map((score) => {
          const { costUsd, perSession } = splitOf(score, "all");
          return [
            run.name,
            score.model,
            score.provider,
            usd(costUsd),
            usd(perSession.costUsd),
            fixed(perSession.inputTokens, 0),
            fixed(perSession.outputTokens, 0),
          ];
        }),
      ),
    ),
  ].join("\n\n");
}

/** The report as Markdown: the case set, the criteria, the summary, each run, the regressions, the held-out score
 * and the cost. Throws when a file the run list names isn't in `results`. */
export function renderReport({ runs, results, cases, targets }: ReportInputs): string {
  const scored = runs.runs.map((run) => {
    const lines = linesOf(results, run.results);
    return { run, lines, scores: scoreResults(lines, targets) };
  });
  return `${[
    "_Generated by `pnpm --filter @warden/server eval:report` from `docs/eval/runs.json` and the results files in " +
      "`docs/eval/results/`. It isn't edited by hand: change those and render it again._",
    "# The Judge's eval",
    caseSet(runs.about, cases),
    criteria(targets),
    summary(scored),
    ...scored.map(runSection),
    regressions(scored, results),
    heldOutScore(scored),
    cost(scored),
  ].join("\n\n")}\n`;
}
