// Writes the Judge eval's report (spec #225, story 17; slice 13a) from the run list and the results files it names,
// with no database and no model: `pnpm --filter @warden/server eval:report`, which writes `docs/eval/report.md` from
// `docs/eval/runs.json`, or `eval:report -- <runs.json> <report.md>`. The results files sit in `results/` beside the
// run list. Anything wrong in the inputs exits 2, naming it, and writes nothing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs, isMain } from "./cli.ts";
import { loadEvalCases, loadEvalTargets } from "./eval-cases.ts";
import { renderReport, ReportRuns, type ReportInputs } from "./report.ts";
import { readResults, type EvalResultLine } from "./results.ts";

const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));
/** The committed run list, and the report rendered from it. */
export const RUNS_FILE = join(REPO_DIR, "docs/eval/runs.json");
export const REPORT_FILE = join(REPO_DIR, "docs/eval/report.md");

const USAGE = "usage: pnpm --filter @warden/server eval:report [-- <runs.json> <report.md>]";

/** The run list at `runsFile`, each results file it names (from `results/` beside it), the cases and the targets;
 * throws naming the file and what's wrong in it. */
export function readReportInputs(runsFile: string): ReportInputs {
  if (!existsSync(runsFile)) throw new Error(`no run list at ${runsFile}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(runsFile, "utf8"));
  } catch {
    throw new Error(`${runsFile} isn't JSON`);
  }
  const parsed = ReportRuns.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue!.path.length > 0 ? issue!.path.join(".") : "(root)";
    throw new Error(`${runsFile}: ${where} ${issue!.message}`);
  }
  const runs = parsed.data;
  const cases = loadEvalCases();
  const names = new Set(cases.map((c) => c.name));
  const results = new Map<string, readonly EvalResultLine[]>();
  for (const name of runs.runs.flatMap((run) => [run.results, ...run.flip_reruns])) {
    if (results.has(name)) continue;
    const file = join(dirname(runsFile), "results", name);
    const lines = readResults(file);
    const stray = lines.find((line) => !names.has(line.case));
    if (stray !== undefined) throw new Error(`${file}: case "${stray.case}" isn't in the case set`);
    results.set(name, lines);
  }
  return { runs, results, cases, targets: loadEvalTargets() };
}

function main(argv: readonly string[]): number {
  const args = cliArgs(argv);
  if (args.length !== 0 && args.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  // `pnpm --filter` runs this in server/: a relative path is taken from where pnpm was run.
  const from = process.env.INIT_CWD ?? process.cwd();
  const [runsFile, reportFile] =
    args.length === 0 ? [RUNS_FILE, REPORT_FILE] : args.map((given) => resolve(from, given));
  try {
    const report = renderReport(readReportInputs(runsFile!));
    writeFileSync(reportFile!, report);
    console.log(`wrote ${reportFile}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
