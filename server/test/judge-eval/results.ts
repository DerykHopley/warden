// The Judge eval's saved results (spec #225, slice 10b): one JSON line per case run on a model, added to the results
// file before the next case, so a stopped run keeps what it did and the next one carries on from it. The regression
// check (10c) reads the same file through `readResults`.
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";
import { JUDGE_RULES } from "../../src/modules/guard/judge-rules.ts";
import type { SessionOutcome } from "../../src/modules/guard/agent-sessions.ts";
import { CASE_GROUPS, CASE_SPLITS } from "./eval-cases.ts";
import { EVAL_PROVIDERS } from "./settings.ts";

const JudgeRuleId = z.enum(JUDGE_RULES.map((rule) => rule.ruleId) as [string, ...string[]]);
const Count = z.number().int().nonnegative();

/** Each SessionOutcome, keyed by itself: an outcome added to or dropped from SessionOutcome won't compile here. */
const OUTCOMES = {
  flagged: "flagged",
  clean: "clean",
  needs_human_review: "needs_human_review",
} as const satisfies { [Outcome in SessionOutcome]: Outcome };

/** One case's result on one model. */
export const EvalResultLine = z.strictObject({
  model: z.string().min(1),
  provider: z.enum(EVAL_PROVIDERS),
  case: z.string().min(1),
  group: z.enum(CASE_GROUPS),
  split: z.enum(CASE_SPLITS),
  labels: z.array(JudgeRuleId),
  /** The Judge Rules with a Finding on the session's Asset, sorted. */
  flagged: z.array(JudgeRuleId),
  /** Labels not flagged. */
  missing: z.array(JudgeRuleId),
  /** Rules flagged beyond the labels. */
  extra: z.array(JudgeRuleId),
  /** The session's outcome; null when the run wasn't judged (`error` says why). */
  outcome: z.enum(OUTCOMES).nullable(),
  pass: z.boolean(),
  /** What the calls' usage stated, added up; null when none stated it. */
  input_tokens: Count.nullable(),
  output_tokens: Count.nullable(),
  /** What the calls cost: as stated, or UNPRICED_CALL_USD for one that stated none; always 0 for a local model. */
  cost_usd: z.number().nonnegative(),
  calls: Count,
  events_read: Count.nullable(),
  events_cut: Count.nullable(),
  /** From the first event's post to the end of the Judge run. */
  ms: z.number().nonnegative(),
  /** The model call's failure, or the outcome's kind (`limited`) when the run judged nothing; null when judged. */
  error: z.string().nullable(),
  at: z.iso.datetime(),
});

export type EvalResultLine = z.infer<typeof EvalResultLine>;

/** Whether a case passed: judged without error, not left for a person, and flagged exactly its labels. */
export const casePasses = (
  result: Pick<EvalResultLine, "error" | "outcome" | "missing" | "extra">,
) =>
  result.error === null &&
  result.outcome !== "needs_human_review" &&
  result.missing.length === 0 &&
  result.extra.length === 0;

/** A case's labels not flagged (`missing`), the Rules flagged beyond them (`extra`), and whether it passed. */
export function caseVerdict(
  result: Pick<EvalResultLine, "labels" | "flagged" | "error" | "outcome">,
): Pick<EvalResultLine, "missing" | "extra" | "pass"> {
  const missing = result.labels.filter((rule) => !result.flagged.includes(rule));
  const extra = result.flagged.filter((rule) => !result.labels.includes(rule));
  const { error, outcome } = result;
  return { missing, extra, pass: casePasses({ error, outcome, missing, extra }) };
}

/** Every line in the results file `file`, blank lines skipped; throws naming the file and the 1-based line number. */
export function readResults(file: string): EvalResultLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`can't read the results file ${file}`, { cause: error });
  }
  return text.split("\n").flatMap((raw, i) => {
    if (raw.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${file} line ${i + 1} isn't JSON`);
    }
    const parsed = EvalResultLine.safeParse(value);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const where = issue!.path.length > 0 ? issue!.path.join(".") : "(root)";
      throw new Error(`${file} line ${i + 1} isn't a result: ${where} ${issue!.message}`);
    }
    return [parsed.data];
  });
}

/** Adds `result` to the results file, checked, as one line. */
export function appendResult(file: string, result: EvalResultLine): void {
  appendFileSync(file, `${JSON.stringify(EvalResultLine.parse(result))}\n`);
}

/** The model a line is on: its provider and name. */
export type ResultModel = Pick<EvalResultLine, "provider" | "model">;

/** The model a line, or a run's model, is on, as one key. */
export const modelKey = (on: ResultModel) => JSON.stringify([on.provider, on.model]);

/** The model and case a line is the result of: a later line for the same one replaces it. */
export const resultKey = (result: Pick<EvalResultLine, "provider" | "model" | "case">) =>
  JSON.stringify([result.provider, result.model, result.case]);

/** Each (model, case)'s latest line, in the order each was first saved. */
export function latestResults(results: readonly EvalResultLine[]): EvalResultLine[] {
  const latest = new Map<string, EvalResultLine>();
  for (const result of results) latest.set(resultKey(result), result);
  return [...latest.values()];
}
