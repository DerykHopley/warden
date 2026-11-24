// `@warden/contracts/reconcile-cases`: loads the reconcile cases for Node code (slice 7's runner). Kept out of the
// main entry point, which the dashboard bundles, because it reads the file system.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ReconcileCase } from "./reconcile-case.ts";

/** The package's own cases. */
export const reconcileCasesDir = fileURLToPath(new URL("../reconcile-cases/", import.meta.url));

export interface LoadedReconcileCase {
  /** The case's file name, such as `01-first-scan-opens-a-finding.json`. */
  file: string;
  case: ReconcileCase;
}

/** Loads one case file. A file that isn't JSON, or that `ReconcileCase` refuses, fails with an error naming it. */
export function loadReconcileCase(path: string): ReconcileCase {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not a valid JSON file: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const result = ReconcileCase.safeParse(json);
  if (!result.success) {
    throw new Error(`${path}: not a valid reconcile case:\n${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** Loads every `.json` case in a folder (the package's own by default), in file-name order. Names are unique. */
export function loadReconcileCases(dir: string = reconcileCasesDir): LoadedReconcileCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const byName = new Map<string, string>();
  return files.map((name) => {
    const loaded = loadReconcileCase(join(dir, name));
    const earlier = byName.get(loaded.name);
    if (earlier)
      throw new Error(
        `${join(dir, name)}: its name "${loaded.name}" is already used by ${earlier}`,
      );
    byName.set(loaded.name, name);
    return { file: name, case: loaded };
  });
}
