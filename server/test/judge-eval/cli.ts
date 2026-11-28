// What the Judge eval's command-line scripts share (`eval:record`, `eval:score`, `eval:regressions`, `eval:replay`):
// whether a module is the script node started, a script's arguments without the `--` pnpm passes on, and a path's
// spellings (`eval:record`'s leak check and `eval:report`'s input check).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Whether the module at `moduleUrl` (its `import.meta.url`) is the script node was started with, not an import. */
export const isMain = (moduleUrl: string) =>
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);

/** A path's spellings: as given and, when it exists, its real path (links followed). */
export function spellings(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // a path that isn't on this machine
  }
  return [...new Set([path, real])];
}

/** A script's arguments (`process.argv.slice(2)`), without the `--` that `pnpm <script> --` passes on before them. */
export const cliArgs = (argv: readonly string[]) => (argv[0] === "--" ? argv.slice(1) : argv);
