// A hard link to an eval set file, for the tests of the eval writers' input checks (#548): a second name for the same
// file that no spelling of the first reaches.
import { linkSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { EVAL_CASES_DIR } from "./eval-cases.ts";

/** Runs `use` with a hard link to `file`, made in a throwaway folder beside `EVAL_CASES_DIR` (inside the repo, so on
 * its filesystem, and outside the cases' folder, so it isn't read as a case), and removes the folder after. */
export async function withHardLink<T>(file: string, use: (link: string) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(EVAL_CASES_DIR, "..", ".hard-links-"));
  try {
    const link = join(folder, basename(file));
    linkSync(file, link);
    return await use(link);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
