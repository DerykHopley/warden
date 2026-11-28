// Lists each case a rerun of the Judge eval broke (spec #225, story 16; slice 10c), with no database and no model:
// `pnpm --filter @warden/server eval:regressions -- <earlier.jsonl> <later.jsonl>`. It exits 1 when a case broke, 0
// when none did, and 2, saying why, at a wrong argument, a missing or bad file, or no model in both files.
import { dirname, relative, resolve, sep } from "node:path";
import { cliArgs, isMain } from "./cli.ts";
import { DEFAULT_LOCAL_URL, findRegressions, regressionsText } from "./regressions.ts";
import { readResults } from "./results.ts";

const USAGE =
  "usage: pnpm --filter @warden/server eval:regressions -- <earlier.jsonl> <later.jsonl>";

function main(argv: readonly string[]): number {
  const args = cliArgs(argv);
  if (args.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  // `pnpm --filter` runs this in server/: a relative path is taken from where pnpm was run.
  const base = process.env.INIT_CWD ?? process.cwd();
  const [earlier, later] = args.map((given) => resolve(base, given));
  let found;
  try {
    found = findRegressions(readResults(earlier!), readResults(later!));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (found.models.length === 0) {
    console.error(`no model is in both files: ${earlier} and ${later}`);
    return 2;
  }
  // The rerun file goes beside the later file, written from the base `eval:judge` resolves it against: relative
  // under it, absolute outside it.
  const laterFolder = dirname(later!);
  const fromBase = relative(base, laterFolder);
  const folder = fromBase === ".." || fromBase.startsWith(`..${sep}`) ? laterFolder : fromBase;
  const localUrl = process.env.WARDEN_EVAL_LOCAL_URL?.trim() || DEFAULT_LOCAL_URL;
  console.log(regressionsText(found, new Date(), { folder, localUrl }));
  return found.models.some(({ flips }) => flips.length > 0) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
