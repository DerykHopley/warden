// Lists each case a rerun of the Judge eval broke (spec #225, story 16; slice 10c), with no database and no model:
// `pnpm --filter @warden/server eval:regressions -- <earlier.jsonl> <later.jsonl>`. It exits 1 when a case broke, 0
// when none did, and 2, saying why, at a wrong argument, a missing or bad file, or no model in both files.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRegressions, regressionsText } from "./regressions.ts";
import { readResults } from "./results.ts";

const USAGE =
  "usage: pnpm --filter @warden/server eval:regressions -- <earlier.jsonl> <later.jsonl>";

function main(argv: readonly string[]): number {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  // `pnpm --filter` runs this in server/: a relative path is taken from where pnpm was run.
  const [earlier, later] = args.map((given) =>
    resolve(process.env.INIT_CWD ?? process.cwd(), given),
  );
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
  console.log(regressionsText(found));
  return found.models.some(({ flips }) => flips.length > 0) ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
