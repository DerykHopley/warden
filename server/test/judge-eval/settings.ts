// The Judge eval run's settings (spec #225, slice 10b), read from its environment and checked before any case, so a
// run with a missing model, URL, key or results file stops at once, naming the variable and never a key's value.

/** Which cases a run takes: one split of the case set, or every case. */
export const EVAL_SPLITS = ["dev", "held-out", "all"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/** Where a model runs: a Team's own (Ollama's OpenAI-compatible API) or OpenRouter, which is paid. */
export type EvalProvider = "local" | "openrouter";

export type EvalModel = { provider: EvalProvider; model: string };

export type EvalSettings = {
  /** The local models' OpenAI-compatible base URL (`http://localhost:11434/v1`); unset with no local model. */
  localUrl: string | undefined;
  /** Every model, the local ones first. */
  models: EvalModel[];
  /** OpenRouter's key, for its models: never printed. */
  apiKey: string | undefined;
  /** The JSON Lines file each case's result is added to. */
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
 * WARDEN_EVAL_CASES, each case checked against `caseNames`. Throws at the first problem, naming its variable.
 */
export function readEvalSettings(
  env: Record<string, string | undefined>,
  caseNames: readonly string[],
): EvalSettings {
  const local = list(env.WARDEN_EVAL_LOCAL_MODELS);
  const paid = list(env.WARDEN_EVAL_OPENROUTER_MODELS);
  if (local.length === 0 && paid.length === 0)
    throw new Error("name a model: set WARDEN_EVAL_LOCAL_MODELS or WARDEN_EVAL_OPENROUTER_MODELS");
  const localUrl = env.WARDEN_EVAL_LOCAL_URL?.trim() || undefined;
  if (local.length > 0 && localUrl === undefined)
    throw new Error("WARDEN_EVAL_LOCAL_MODELS needs WARDEN_EVAL_LOCAL_URL, the models' base URL");
  if (localUrl !== undefined && !isUrl(localUrl))
    throw new Error("WARDEN_EVAL_LOCAL_URL isn't a URL");
  const apiKey = env.OPENROUTER_API_KEY || undefined;
  if (paid.length > 0 && apiKey === undefined)
    throw new Error("WARDEN_EVAL_OPENROUTER_MODELS needs OPENROUTER_API_KEY");
  const resultsFile = env.WARDEN_EVAL_RESULTS?.trim() || undefined;
  if (resultsFile === undefined)
    throw new Error("set WARDEN_EVAL_RESULTS to the file the results are added to");
  const split = env.WARDEN_EVAL_SPLIT?.trim() || "all";
  if (!(EVAL_SPLITS as readonly string[]).includes(split))
    throw new Error(`WARDEN_EVAL_SPLIT is "${split}", not one of ${EVAL_SPLITS.join(", ")}`);
  const named = env.WARDEN_EVAL_CASES === undefined ? undefined : list(env.WARDEN_EVAL_CASES);
  const unknown = named?.find((name) => !caseNames.includes(name));
  if (unknown !== undefined)
    throw new Error(`WARDEN_EVAL_CASES names "${unknown}", which isn't a case`);
  return {
    localUrl,
    models: [
      ...local.map((model) => ({ provider: "local" as const, model })),
      ...paid.map((model) => ({ provider: "openrouter" as const, model })),
    ],
    apiKey,
    resultsFile,
    split: split as EvalSplit,
    caseNames: named,
  };
}
