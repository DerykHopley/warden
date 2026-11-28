// The Judge eval run's settings (spec #225, slice 10b), read from its environment and checked before any case, so a
// run with a missing model, URL, key or results file stops at once, naming the variable and never a key's value.
import { resolve } from "node:path";
import { CASE_SPLITS } from "./eval-cases.ts";

/** Which cases a run takes: one split of the case set, or every case. */
export const EVAL_SPLITS = [...CASE_SPLITS, "all"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/** Where a model runs: a Team's own (Ollama's OpenAI-compatible API) or OpenRouter, which is paid. */
export const EVAL_PROVIDERS = ["local", "openrouter"] as const;
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

/** A model a run judges with, and what reaching it takes. */
export type EvalModel =
  /** `url` is the local models' OpenAI-compatible base URL (`http://localhost:11434/v1`). */
  | { provider: "local"; model: string; url: string }
  /** `apiKey` is OpenRouter's key: never printed. */
  | { provider: "openrouter"; model: string; apiKey: string };

export type EvalSettings = {
  /** Every model, the local ones first, each named once. */
  models: EvalModel[];
  /** The JSON Lines file each case's result is added to, as an absolute path. */
  resultsFile: string;
  split: EvalSplit;
  /** The cases named, in the order given; undefined for every case in the split. */
  caseNames: string[] | undefined;
};

/** A variable's comma list, each item trimmed, empty ones dropped. */
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/** `variable`'s comma list of models; throws at a model named twice. */
function modelList(env: Record<string, string | undefined>, variable: string): string[] {
  const models = list(env[variable]);
  const twice = models.find((model, i) => models.indexOf(model) !== i);
  if (twice !== undefined) throw new Error(`${variable} names ${twice} twice`);
  return models;
}

const isUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * The run's settings from `env`: WARDEN_EVAL_LOCAL_URL, WARDEN_EVAL_LOCAL_MODELS, WARDEN_EVAL_OPENROUTER_MODELS (with
 * OPENROUTER_API_KEY), WARDEN_EVAL_RESULTS, WARDEN_EVAL_SPLIT (dev, held-out or all, the default) and
 * WARDEN_EVAL_CASES, each case checked against `caseNames`. A relative WARDEN_EVAL_RESULTS is taken from where pnpm
 * was run (INIT_CWD), as `pnpm --filter` runs the script in server/. Throws at the first problem, naming its variable.
 */
export function readEvalSettings(
  env: Record<string, string | undefined>,
  caseNames: readonly string[],
): EvalSettings {
  const local = modelList(env, "WARDEN_EVAL_LOCAL_MODELS");
  const paid = modelList(env, "WARDEN_EVAL_OPENROUTER_MODELS");
  if (local.length === 0 && paid.length === 0)
    throw new Error("name a model: set WARDEN_EVAL_LOCAL_MODELS or WARDEN_EVAL_OPENROUTER_MODELS");
  const url = env.WARDEN_EVAL_LOCAL_URL?.trim() || undefined;
  const locals = local.map((model) => {
    if (url === undefined)
      throw new Error("WARDEN_EVAL_LOCAL_MODELS needs WARDEN_EVAL_LOCAL_URL, the models' base URL");
    return { provider: "local" as const, model, url };
  });
  if (url !== undefined && !isUrl(url)) throw new Error("WARDEN_EVAL_LOCAL_URL isn't a URL");
  const apiKey = env.OPENROUTER_API_KEY || undefined;
  const paids = paid.map((model) => {
    if (apiKey === undefined)
      throw new Error("WARDEN_EVAL_OPENROUTER_MODELS needs OPENROUTER_API_KEY");
    return { provider: "openrouter" as const, model, apiKey };
  });
  const resultsFile = env.WARDEN_EVAL_RESULTS?.trim() || undefined;
  if (resultsFile === undefined)
    throw new Error("set WARDEN_EVAL_RESULTS to the file the results are added to");
  const split = env.WARDEN_EVAL_SPLIT?.trim() || "all";
  if (!(EVAL_SPLITS as readonly string[]).includes(split))
    throw new Error(`WARDEN_EVAL_SPLIT is "${split}", not one of ${EVAL_SPLITS.join(", ")}`);
  const named = env.WARDEN_EVAL_CASES === undefined ? undefined : list(env.WARDEN_EVAL_CASES);
  if (named?.length === 0) throw new Error("WARDEN_EVAL_CASES names no case");
  const unknown = named?.find((name) => !caseNames.includes(name));
  if (unknown !== undefined)
    throw new Error(`WARDEN_EVAL_CASES names "${unknown}", which isn't a case`);
  return {
    models: [...locals, ...paids],
    resultsFile: resolve(env.INIT_CWD ?? process.cwd(), resultsFile),
    split: split as EvalSplit,
    caseNames: named,
  };
}
