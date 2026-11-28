// The Judge eval's regression check (spec #225, story 16; slice 10c): two saved results files compared, each by its
// latest line per (model, case), and each case that passed in the earlier and fails in the later listed under its
// model, with the line that reruns them. `eval:regressions` prints it (`regressions-cli.ts`).
import { latestResults, modelKey, type EvalResultLine, type ResultModel } from "./results.ts";

/** Which of the two files something is in. */
export type InFile = "earlier" | "later";

/** A case that passed in the earlier file and fails in the later: the later line's Rules and error. */
export type Flip = { case: string; missing: string[]; extra: string[]; error: string | null };

/** A model in both files: its flips, and the cases it ran in only one of them. */
export type ModelRegressions = ResultModel & {
  flips: Flip[];
  notInBoth: { case: string; in: InFile }[];
};

export type Regressions = {
  /** Each model in both files, in the order first saved, the earlier file's first. */
  models: ModelRegressions[];
  /** Each model in only one file, in the same order. */
  onlyIn: (ResultModel & { in: InFile })[];
};

/** A model's latest lines, by case. */
type ModelLines = ResultModel & { cases: Map<string, EvalResultLine> };

/** Each model's latest lines by case, keyed by `modelKey`, in the order each model was first saved. */
function byModel(results: readonly EvalResultLine[]): Map<string, ModelLines> {
  const models = new Map<string, ModelLines>();
  for (const result of latestResults(results)) {
    const key = modelKey(result);
    const { provider, model } = result;
    if (!models.has(key)) models.set(key, { provider, model, cases: new Map() });
    models.get(key)!.cases.set(result.case, result);
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
    const was = before.get(key);
    const now = after.get(key);
    if (was === undefined || now === undefined) {
      const { provider, model } = (was ?? now)!;
      regressions.onlyIn.push({ provider, model, in: was === undefined ? "later" : "earlier" });
      continue;
    }
    const flips: Flip[] = [];
    const notInBoth: ModelRegressions["notInBoth"] = [];
    for (const [name, then] of was.cases) {
      const line = now.cases.get(name);
      if (line === undefined) notInBoth.push({ case: name, in: "earlier" });
      else if (then.pass && !line.pass)
        flips.push({ case: name, missing: line.missing, extra: line.extra, error: line.error });
    }
    for (const name of now.cases.keys())
      if (!was.cases.has(name)) notInBoth.push({ case: name, in: "later" });
    const { provider, model } = was;
    regressions.models.push({ provider, model, flips, notInBoth });
  }
  return regressions;
}

/** `model` as a file name's part: anything but letters, digits, `.`, `_` and `-` made a `-`. */
const fileSafe = (model: string) => model.replace(/[^A-Za-z0-9._-]/g, "-");

/** `at` as a file name's part: its ISO time to the millisecond, without `-` and `:` (`20261128T100000.000Z`). */
const fileTime = (at: Date) => at.toISOString().replace(/[-:]/g, "");

/** What the rerun line of an OpenRouter model ends with: a paid run waits for the owner. Pasted as it is, the shell
 * refuses it, so it can't start a paid run by accident. */
const PAID_NOTE = "(paid: OpenRouter — needs the owner's yes)";

/**
 * The line that reruns `cases` once on `model` alone, taken from where pnpm is run, into a results file named by the
 * provider, the model and `at` (when `eval:regressions` ran): the harness skips a (model, case) its results file
 * already holds, so each run's line names a new one. An OpenRouter model's line ends with PAID_NOTE.
 */
export function rerunLine({ provider, model }: ResultModel, cases: readonly string[], at: Date) {
  const models =
    provider === "local" ? "WARDEN_EVAL_LOCAL_MODELS" : "WARDEN_EVAL_OPENROUTER_MODELS";
  const line =
    `WARDEN_EVAL_RESULTS=rerun-${provider}-${fileSafe(model)}-${fileTime(at)}.jsonl ${models}=${model} ` +
    `WARDEN_EVAL_CASES=${cases.join(",")} pnpm --filter @warden/server eval:judge`;
  return provider === "openrouter" ? `${line} ${PAID_NOTE}` : line;
}

const rules = (list: readonly string[]) => (list.length === 0 ? "none" : list.join(", "));

/** The regressions as `eval:regressions` prints them at `at`: each model's flips and rerun line, then the one-file
 * models. */
export function regressionsText({ models, onlyIn }: Regressions, at: Date): string {
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
          at,
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
