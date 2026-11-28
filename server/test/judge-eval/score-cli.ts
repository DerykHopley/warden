// Prints the Judge eval's score from a saved results file (spec #225, slice 10b), with no database and no model:
// `pnpm --filter @warden/server eval:score -- <results.jsonl>`. A missing file or a bad line exits 1, naming it.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalTargets } from "./eval-cases.ts";
import { readResults } from "./results.ts";
import { scoreResults, scoreTable } from "./score.ts";

const USAGE = "usage: pnpm --filter @warden/server eval:score -- <results.jsonl>";

function main(argv: readonly string[]): number {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const [given] = args as [string];
  // `pnpm --filter` runs this in server/: a relative path is taken from where pnpm was run.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), given);
  if (!existsSync(file)) {
    console.error(`no results file at ${file}`);
    return 1;
  }
  try {
    console.log(scoreTable(scoreResults(readResults(file), loadEvalTargets())));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
