// The Judge's verdict (spec #225, slice 5a): the JSON schema the model answers to, and its answer read into
// Observations on the Agent session. An answer the Judge can't act on (a refusal, content that isn't JSON or fails the
// schema, a Rule that isn't the Judge's, a cited event it didn't read, or a Rule with none) reports nothing and asks a
// person to review the session.
import type { MaskedAgentEvent, Observation } from "@warden/contracts";
import { z } from "zod";
import type { ModelAnswer } from "./judge-model.ts";
import { cut } from "./judge-prompt.ts";
import { JUDGE_RULES, judgeRule } from "./judge-rules.ts";

/** The most cited events one Finding keeps, as the contracts' `SessionEvidence` holds them. */
const MAX_CITED_EVENTS = 50;

/** The longest evidence summary, as the contracts hold it. */
const MAX_SUMMARY_LENGTH = 2000;

/**
 * The verdict's JSON schema, sent as the request's `response_format`: every field required and no other, as strict
 * structured outputs ask. The Rule ids are the Judge's.
 */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    broken_rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule_id: { type: "string", enum: JUDGE_RULES.map((rule) => rule.ruleId) },
          summary: { type: "string" },
          event_seqs: { type: "array", items: { type: "integer" } },
        },
        required: ["rule_id", "summary", "event_seqs"],
        additionalProperties: false,
      },
    },
  },
  required: ["broken_rules"],
  additionalProperties: false,
} as const;

/** The same verdict, checked here: the model may not have honoured the schema. */
const Verdict = z.strictObject({
  broken_rules: z.array(
    z.strictObject({
      rule_id: z.string(),
      summary: z.string().trim().min(1),
      event_seqs: z.array(z.int().min(0)),
    }),
  ),
});

export type VerdictOutcome =
  | { kind: "observations"; observations: Observation[] }
  | { kind: "needs_human_review"; reason: string };

const review = (reason: string): VerdictOutcome => ({ kind: "needs_human_review", reason });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The model's answer as Observations on the session `sessionId`: one per broken Rule, a Rule listed twice merged into
 * one (its summaries joined, its events together), with the Rule's severity and title, the summary cut to 2,000, and
 * at most the first 50 cited events in session order beside `events_read` and `events_hash`. The reason a person must
 * review it otherwise; the reason never holds the answer's text.
 */
export function readVerdict(
  answer: ModelAnswer,
  {
    sessionId,
    events,
    eventsHash,
  }: { sessionId: string; events: readonly MaskedAgentEvent[]; eventsHash: string },
): VerdictOutcome {
  if (answer.refusal) return review("the model refused");
  const parsed = Verdict.safeParse(parseJson(answer.content));
  if (!parsed.success) return review("the answer isn't a verdict");

  const byRule = new Map<string, { summaries: string[]; seqs: Set<number> }>();
  for (const { rule_id, summary, event_seqs } of parsed.data.broken_rules) {
    if (judgeRule(rule_id) === undefined)
      return review("the answer names a Rule that isn't the Judge's");
    if (event_seqs.length === 0) return review("the answer cites no event for a Rule");
    if (event_seqs.some((seq) => seq >= events.length)) {
      return review("the answer cites an event the Judge didn't read");
    }
    const entry = byRule.get(rule_id) ?? { summaries: [], seqs: new Set<number>() };
    entry.summaries.push(summary.trim());
    for (const seq of event_seqs) entry.seqs.add(seq);
    byRule.set(rule_id, entry);
  }

  const observations = [...byRule].map(([ruleId, { summaries, seqs }]): Observation => {
    const rule = judgeRule(ruleId)!;
    const cited = [...seqs].sort((a, b) => a - b).slice(0, MAX_CITED_EVENTS);
    return {
      asset: { kind: "agent_session", ref: sessionId },
      rule_id: rule.ruleId,
      location: { kind: "session" },
      severity: rule.severity,
      title: rule.title,
      evidence: {
        summary: cut(summaries.join(" "), MAX_SUMMARY_LENGTH),
        session: {
          events: cited.map((seq) => events[seq]!),
          events_read: events.length,
          events_hash: eventsHash,
        },
      },
    };
  });
  return { kind: "observations", observations };
}
