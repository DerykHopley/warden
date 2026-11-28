// The Judge's eval set (spec #225, story 13; slice 10a): one JSON file per labelled Agent session in
// `session-fixtures/eval/`, and `targets.json`, the pass targets fixed before any run. Each case's events are Claude
// Code's hook bodies without their `session_id`, posted in order at the case's Privacy tier. The harness (10b) and the
// live attack replay (10c) read the cases through `loadEvalCases`, so a case is checked and its secrets filled in one
// place.
//
// A made-up secret sits in a case file only as a placeholder naming a string export of `secret-fixtures.ts`
// (`{{AWS_KEY}}`), so no tracked file holds a whole secret for a Guard Scan of Warden to report.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivacyTier } from "@warden/contracts";
import { z } from "zod";
import { JUDGE_RULES } from "../../src/modules/guard/judge-rules.ts";
import { HOOK_EVENTS } from "../../src/modules/guard/managed-settings.ts";
import * as secretFixtures from "../secret-fixtures.ts";

/** The folder the cases and the targets sit in. */
export const EVAL_CASES_DIR = fileURLToPath(new URL("../session-fixtures/eval/", import.meta.url));

/** The targets' file, in the cases' folder: every other `.json` file there is a case. */
export const TARGETS_FILE = "targets.json";

export const CASE_GROUPS = ["misbehaving", "injection", "near-miss", "ordinary"] as const;
export const CASE_SPLITS = ["dev", "held-out"] as const;
export const CASE_SOURCES = ["hand-written", "recorded"] as const;
/** Ordinary work's lengths, by the recorder's turn cap. */
export const CASE_LENGTHS = ["short", "medium", "long"] as const;
export type CaseLength = (typeof CASE_LENGTHS)[number];

/** How many turns the recorder lets a session of each length run. */
export const TURN_CAPS: Record<CaseLength, number> = { short: 2, medium: 4, long: 8 };

const JudgeRuleId = z.enum(JUDGE_RULES.map((rule) => rule.ruleId) as [string, ...string[]]);

/** One hook body: an event the managed-settings block sends, with Claude Code's other fields as they came. */
const HookBody = z
  .looseObject({ hook_event_name: z.enum(HOOK_EVENTS as [string, ...string[]]) })
  .refine((body) => !Object.hasOwn(body, "session_id"), {
    message: "holds a session_id: the hook endpoint gives each replay its own",
  });

const EvalCaseSchema = z
  .strictObject({
    name: z.string().min(1),
    /** What the session does, in a sentence. */
    description: z.string().min(1),
    group: z.enum(CASE_GROUPS),
    split: z.enum(CASE_SPLITS),
    /** The Privacy tier the case is replayed at. */
    tier: PrivacyTier,
    /** The Judge Rules a correct run flags; `[]` for a clean case. */
    labels: z.array(JudgeRuleId),
    /** The threat-model row or the Rule the case covers: `guard/agent-sends-secrets`, `J2`. */
    stands_for: z.string().min(1),
    source: z.enum(CASE_SOURCES),
    /** Ordinary work's length, by its turn cap; absent for the other groups. */
    length: z.enum(CASE_LENGTHS).optional(),
    /** The demo's live attack, which the replay (10c) sends. */
    replay: z.literal(true).optional(),
    events: z.array(HookBody).min(1),
  })
  .superRefine((c, context) => {
    const names = c.events.map((event) => event.hook_event_name);
    if (names.at(-1) !== "SessionEnd" || names.indexOf("SessionEnd") !== names.length - 1)
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "must end in SessionEnd, once",
      });
    if (new Set(c.labels).size !== c.labels.length)
      context.addIssue({ code: "custom", path: ["labels"], message: "names a Rule twice" });
    if ((c.length !== undefined) !== (c.group === "ordinary"))
      context.addIssue({
        code: "custom",
        path: ["length"],
        message: "is set for ordinary work, and only for it",
      });
  });

export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** One hook body of a case. */
export type HookBody = EvalCase["events"][number];

const Target = z.strictObject({ description: z.string().min(1) });

/** `targets.json`: the pass criteria (the spec's "Success criteria"), fixed before the first run. */
const EvalTargetsSchema = z.strictObject({
  description: z.string().min(1),
  high_rule_recall: Target.extend({ rules: z.array(JudgeRuleId), at_least: z.number() }),
  precision: Target.extend({ at_least: z.number() }),
  ordinary_flagged: Target.extend({ at_most: z.number() }),
  injection: Target.extend({
    rule: JudgeRuleId,
    flagged: z.literal("every case"),
    marked_clean: z.literal("no case"),
  }),
  cost_per_session_usd: Target.extend({ under: z.number(), paid_models_only: z.literal(true) }),
});

export type EvalTargets = z.infer<typeof EvalTargetsSchema>;

/** Each string export of `secret-fixtures.ts` by its name: the secrets a placeholder may name. */
export const FIXTURE_SECRETS: ReadonlyMap<string, string> = new Map(
  Object.entries(secretFixtures).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

/** `value` with each placeholder in its strings, keys included, filled; throws naming `caseName` at an unknown one. */
function fillPlaceholders(value: unknown, caseName: string): unknown {
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (placeholder, name: string) => {
      const secret = FIXTURE_SECRETS.get(name);
      if (secret === undefined)
        throw new Error(
          `case "${caseName}": unknown placeholder ${placeholder}, not a string export of secret-fixtures.ts`,
        );
      return secret;
    });
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map((item) => fillPlaceholders(item, caseName));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [fill(key), fillPlaceholders(item, caseName)]),
    );
  return value;
}

/** One case file's case, checked, with its placeholders filled; throws naming the case at the first problem. */
function loadCase(folder: string, file: string): EvalCase {
  const name = file.replace(/\.json$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(folder, file), "utf8"));
  } catch (error) {
    throw new Error(`case "${name}": isn't JSON`, { cause: error });
  }
  const parsed = EvalCaseSchema.safeParse(fillPlaceholders(raw, name));
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`case "${name}": ${issue!.path.join(".")} ${issue!.message}`);
  }
  if (parsed.data.name !== name)
    throw new Error(`case "${name}": name is "${parsed.data.name}", not the file's`);
  return parsed.data;
}

/** Every case in `folder` (the eval set's by default), by name, each checked and with its secrets filled in. */
export function loadEvalCases(folder: string = EVAL_CASES_DIR): EvalCase[] {
  return readdirSync(folder)
    .filter((file) => file.endsWith(".json") && file !== TARGETS_FILE)
    .sort()
    .map((file) => loadCase(folder, file));
}

/** The eval's pass targets, from `targets.json` in `folder`. */
export function loadEvalTargets(folder: string = EVAL_CASES_DIR): EvalTargets {
  return EvalTargetsSchema.parse(JSON.parse(readFileSync(join(folder, TARGETS_FILE), "utf8")));
}

/** Every string in a case's events, keys included, joined by line breaks: what a search for a phrase reads. */
export function eventText(c: EvalCase): string {
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) {
        strings.push(key);
        walk(item);
      }
  };
  walk(c.events);
  return strings.join("\n");
}
