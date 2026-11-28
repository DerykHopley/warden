// The Judge eval's regression check (spec #225, story 16; slice 10c): two saved results files compared, each by its
// latest line per (model, case), and each case that passed in the earlier and fails in the later listed under its
// model, with the line that reruns them. `eval:regressions` prints it (`regressions-cli.ts`).
import { latestResults, modelKey, type EvalResultLine } from "./results.ts";
import type { EvalProvider } from "./settings.ts";

/** Which of the two files something is in. */
export type InFile = "earlier" | "later";

/** A case that passed in the earlier file and fails in the later: the later line's Rules and error. */
export type Flip = { case: string; missing: string[]; extra: string[]; error: string | null };

type Model = { provider: EvalProvider; model: string };

/** A model in both files: its flips, and the cases it ran in only one of them. */
export type ModelRegressions = Model & {
  flips: Flip[];
  notInBoth: { case: string; in: InFile }[];
};

export type Regressions = {
  /** Each model in both files, in the order first saved, the earlier file's first. */
  models: ModelRegressions[];
  /** Each model in only one file, in the same order. */
  onlyIn: (Model & { in: InFile })[];
};

/** Each model's latest lines by case, in the order each model was first saved. */
function byModel(results: readonly EvalResultLine[]): Map<string, Map<string, EvalResultLine>> {
  const models = new Map<string, Map<string, EvalResultLine>>();
  for (const result of latestResults(results)) {
    const key = modelKey(result);
    if (!models.has(key)) models.set(key, new Map());
    models.get(key)!.set(result.case, result);
  }
  return models;
}

/** The flips from `earlier` to `later`, each file read by its latest line per (model, case). */
export function findRegressions(
  earlier: readonly EvalResultLine[],
  later: readonly EvalResultLine[],
): Regressions {
  const before = byModel(earlier);
  const after = byModel(later);
  const regressions: Regressions = { models: [], onlyIn: [] };
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const [provider, model] = JSON.parse(key) as [EvalProvider, string];
    const was = before.get(key);
    const now = after.get(key);
    if (was === undefined || now === undefined) {
      regressions.onlyIn.push({ provider, model, in: was === undefined ? "later" : "earlier" });
      continue;
    }
    const flips: Flip[] = [];
    const notInBoth: ModelRegressions["notInBoth"] = [];
    for (const [name, then] of was) {
      const line = now.get(name);
      if (line === undefined) notInBoth.push({ case: name, in: "earlier" });
      else if (then.pass && !line.pass)
        flips.push({ case: name, missing: line.missing, extra: line.extra, error: line.error });
    }
    for (const name of now.keys()) if (!was.has(name)) notInBoth.push({ case: name, in: "later" });
    regressions.models.push({ provider, model, flips, notInBoth });
  }
  return regressions;
}

/** `model` as a file name's part: anything but letters, digits, `.`, `_` and `-` made a `-`. */
const fileSafe = (model: string) => model.replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * The line that reruns `cases` once on `model` alone, into a results file of its own (the harness skips a (model,
 * case) its results file already holds), taken from where pnpm is run.
 */
export function rerunLine({ provider, model }: Model, cases: readonly string[]): string {
  const models =
    provider === "local" ? "WARDEN_EVAL_LOCAL_MODELS" : "WARDEN_EVAL_OPENROUTER_MODELS";
  return (
    `WARDEN_EVAL_RESULTS=rerun-${fileSafe(model)}.jsonl ${models}=${model} ` +
    `WARDEN_EVAL_CASES=${cases.join(",")} pnpm --filter @warden/server eval:judge`
  );
}

const rules = (list: readonly string[]) => (list.length === 0 ? "none" : list.join(", "));

/** The regressions as `eval:regressions` prints them: each model's flips and rerun line, then the one-file models. */
export function regressionsText({ models, onlyIn }: Regressions): string {
  const lines: string[] = [];
  for (const found of models) {
    const { provider, model, flips, notInBoth } = found;
    const count =
      flips.length === 0 ? "no case" : `${flips.length} case${flips.length === 1 ? "" : "s"}`;
    lines.push(`${provider} ${model}: ${count} broke`);
    for (const flip of flips)
      lines.push(
        `  ${flip.case}: ${flip.error ?? `missing ${rules(flip.missing)}; extra ${rules(flip.extra)}`}`,
      );
    if (flips.length > 0)
      lines.push(
        `  rerun: ${rerunLine(
          found,
          flips.map((flip) => flip.case),
        )}`,
      );
    if (notInBoth.length > 0)
      lines.push(
        `  not in both: ${notInBoth.map((one) => `${one.case} (${one.in} only)`).join(", ")}`,
      );
  }
  for (const { provider, model, in: file } of onlyIn)
    lines.push(`${provider} ${model}: only in the ${file} file`);
  return lines.join("\n");
}
