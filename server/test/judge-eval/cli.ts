// What the Judge eval's command-line scripts share (`eval:record`, `eval:score`, `eval:regressions`, `eval:replay`):
// whether a module is the script node started, and a script's arguments without the `--` pnpm passes on.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Whether the module at `moduleUrl` (its `import.meta.url`) is the script node was started with, not an import. */
export const isMain = (moduleUrl: string) =>
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);

/** A script's arguments (`process.argv.slice(2)`), without the `--` that `pnpm <script> --` passes on before them. */
export const cliArgs = (argv: readonly string[]) => (argv[0] === "--" ? argv.slice(1) : argv);
