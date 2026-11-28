// Writes the Judge eval's report (spec #225, story 17; slice 13a) from the run list and the results files it names,
// with no database and no model: `pnpm --filter @warden/server eval:report`, which writes `docs/eval/report.md` from
// `docs/eval/runs.json`, or `eval:report -- <runs.json> <report.md>`. The results files sit in `results/` beside the
// run list. Anything wrong in the inputs exits 2, naming it, and writes nothing: so does a report path that is one of
// the files it reads, an empty results file, and a run's results file missing a case for a model in it (#546).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs, isMain, spellings } from "./cli.ts";
import {
  evalSetFiles,
  firstIssue,
  loadEvalCases,
  loadEvalTargets,
  type EvalCase,
} from "./eval-cases.ts";
import { renderReport, ReportRuns, type ReportInputs } from "./report.ts";
import { byModel, readResults, type EvalResultLine } from "./results.ts";

const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));
/** The committed run list, and the report rendered from it. */
export const RUNS_FILE = join(REPO_DIR, "docs/eval/runs.json");
export const REPORT_FILE = join(REPO_DIR, "docs/eval/report.md");

const USAGE = "usage: pnpm --filter @warden/server eval:report [-- <runs.json> <report.md>]";

/** `runsFile`'s path as the report's header shows it: from the repo root, with `/`, when it's inside the repo. */
function shownPath(runsFile: string): string {
  const resolved = resolve(runsFile);
  const inRepo = relative(REPO_DIR, resolved);
  return inRepo === "" || inRepo.startsWith("..") || isAbsolute(inRepo)
    ? resolved
    : inRepo.split(sep).join("/");
}

/** The first case in the case set's order that a model with a line in `lines` has no line for, as a message. */
function missingCase(lines: readonly EvalResultLine[], cases: readonly EvalCase[]): string | null {
  for (const { provider, model, cases: has } of byModel(lines).values()) {
    const missing = cases.find((c) => !has.has(c.name));
    if (missing !== undefined)
      return `${model} (${provider}) has no line for case "${missing.name}"`;
  }
  return null;
}

/** The run list at `runsFile`, each results file it names (from `results/` beside it), the cases and the targets,
 * with every file read for them (`files`): the run list, the results files, `targets.json` and the case files. Throws
 * naming the file and what's wrong in it: a results file holding no line, or a run's results file without a line for
 * some case on a model in it. */
export function readReportInputs(runsFile: string): { inputs: ReportInputs; files: string[] } {
  if (!existsSync(runsFile)) throw new Error(`no run list at ${runsFile}`);
  let text: string;
  try {
    text = readFileSync(runsFile, "utf8");
  } catch (error) {
    throw new Error(`can't read the run list ${runsFile}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${runsFile} isn't JSON`);
  }
  const parsed = ReportRuns.safeParse(value);
  if (!parsed.success) throw new Error(`${runsFile}: ${firstIssue(parsed.error)}`);
  const runs = parsed.data;
  const cases = loadEvalCases();
  const byName = new Map(cases.map((c) => [c.name, c]));
  // A flip-rerun file holds only the flipped cases, so only a run's own results file must hold every case.
  const runResults = new Set(runs.runs.map((run) => run.results));
  const results = new Map<string, readonly EvalResultLine[]>();
  const files = [runsFile, ...evalSetFiles()];
  for (const name of runs.runs.flatMap((run) => [run.results, ...run.flip_reruns])) {
    if (results.has(name)) continue;
    const file = join(dirname(runsFile), "results", name);
    files.push(file);
    const lines = readResults(file);
    for (const line of lines) {
      const mismatch = caseMismatch(line, byName.get(line.case));
      if (mismatch !== null) throw new Error(`${file}: case "${line.case}" ${mismatch}`);
    }
    if (lines.length === 0) throw new Error(`${file} holds no results`);
    const missing = runResults.has(name) ? missingCase(lines, cases) : null;
    if (missing !== null) throw new Error(`${file}: ${missing}`);
    results.set(name, lines);
  }
  const inputs = {
    runs,
    runsFile: shownPath(runsFile),
    results,
    cases,
    targets: loadEvalTargets(),
  };
  return { inputs, files };
}

/** `path` resolved, and where its links lead when it exists. */
const namesOf = (path: string) => spellings(resolve(path));

/** Whether `reportFile` is one of `inputs`, compared after `resolve` and after following links. */
function isInput(reportFile: string, inputs: readonly string[]): boolean {
  const read = new Set(inputs.flatMap(namesOf));
  return namesOf(reportFile).some((name) => read.has(name));
}

/** A case's labels in words, in any order: `clean` for none. */
const labelText = (labels: readonly string[]) =>
  labels.length === 0 ? "clean" : labels.toSorted().join(", ");

/** What's wrong with `line` against its case in the case set (`c`), or null when nothing is: a case that isn't there,
 * or a split, group or labels the case no longer has. */
function caseMismatch(line: EvalResultLine, c: EvalCase | undefined): string | null {
  if (c === undefined) return "isn't in the case set";
  const fields: [string, string, string][] = [
    ["split", line.split, c.split],
    ["group", line.group, c.group],
    ["labels", labelText(line.labels), labelText(c.labels)],
  ];
  const wrong = fields.find(([, here, there]) => here !== there);
  return wrong === undefined ? null : `has ${wrong[0]} ${wrong[1]}, not the case set's ${wrong[2]}`;
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
    const { inputs, files } = readReportInputs(runsFile!);
    if (isInput(reportFile!, files))
      throw new Error(`${reportFile} is one of eval:report's inputs`);
    const report = renderReport(inputs);
    writeFileSync(reportFile!, report);
    console.log(`wrote ${reportFile}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
