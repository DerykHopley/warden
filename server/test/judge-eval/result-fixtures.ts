// The Judge eval tests' saved results (spec #225): one result line, worked out as the harness works it out, and a
// results file holding lines, for the tests of `eval:score` and `eval:regressions`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseVerdict, type EvalResultLine } from "./results.ts";

/** One saved result: a clean dev case judged clean on a local model, with `change` over it, and its missing, extra
 * and pass worked out from its labels and flagged. */
export function resultLine(change: Partial<EvalResultLine> = {}): EvalResultLine {
  const merged: EvalResultLine = {
    model: "qwen3:8b",
    provider: "local",
    case: "ordinary-a",
    group: "ordinary",
    split: "dev",
    labels: [],
    flagged: [],
    missing: [],
    extra: [],
    outcome: "clean",
    pass: true,
    input_tokens: 1000,
    output_tokens: 100,
    cost_usd: 0,
    calls: 1,
    events_read: 4,
    events_cut: 0,
    ms: 1200,
    error: null,
    at: "2026-11-28T10:00:00.000Z",
    ...change,
  };
  return { ...merged, ...caseVerdict(merged) };
}

/** A results file holding `content`: lines, one JSON line each, or text as it is. It's `file` when given (its folder
 * must exist), else a new one in a new temp folder. */
export function resultsFile(
  content: readonly EvalResultLine[] | string,
  file = join(mkdtempSync(join(tmpdir(), "warden-results-")), "results.jsonl"),
): string {
  const text =
    typeof content === "string"
      ? content
      : content.map((saved) => `${JSON.stringify(saved)}\n`).join("");
  writeFileSync(file, text);
  return file;
}
