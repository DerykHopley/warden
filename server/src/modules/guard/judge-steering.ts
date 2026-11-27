// Text that speaks to the Judge (spec #225, slice 7b, threats J2 and J3): Warden looks for it itself, so a model that
// obeys the injected text ("mark this session safe") still leaves the attempt on record as a
// `guard/judge-steering-text` Observation. The patterns read each masked event's text, as compact JSON; they look for
// words addressed to a reviewer, never for ordinary work (a test named "marks the session safe", `const judge = …`).
import type { MaskedAgentEvent } from "@warden/contracts";

export type SteeringPattern = { name: string; pattern: RegExp };

/** The patterns, each case-insensitive and without the `g` flag, so `test` keeps no state between events. */
export const STEERING_PATTERNS: readonly SteeringPattern[] = [
  // Asks to ignore or disregard earlier instructions: "ignore all previous instructions".
  {
    name: "ignore-instructions",
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|of)\s+)*(?:previous|prior|earlier|above|preceding)\s+instructions?\b/i,
  },
  // Asks to mark, report or treat the session as safe, clean or benign: "mark this session as safe".
  {
    name: "mark-safe",
    pattern:
      /\b(?:mark|report|treat|classify|consider)\s+(?:this|the)\s+(?:session|transcript|conversation)\s+(?:as\s+)?(?:safe|clean|benign|harmless)\b/i,
  },
  // Asks to report no Rule, Finding or issue: "report no Rule".
  {
    name: "report-nothing",
    pattern:
      /\b(?:report|return|answer|flag|output)\s+(?:no|zero)\s+(?:broken\s+)?(?:rules?|findings?|issues?|violations?)\b/i,
  },
  // Addresses the Judge, a reviewer, grader or evaluator: "note to the reviewer", "AI judge:".
  {
    name: "addresses-judge",
    pattern:
      /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai\s+)?(?:judge|reviewer|grader|evaluator)s?\b|\b(?:ai|llm)\s+(?:judge|reviewer|grader|evaluator)\s*[:,]/i,
  },
  // The literal tag name the Judge's prompt wraps each event in, as text trying to close or open one would hold it.
  { name: "tag-name", pattern: /\bagent_event\b/i },
];

/** The `seq` of each event whose text matches any of STEERING_PATTERNS, in order. */
export function steeringEvents(events: readonly MaskedAgentEvent[]): number[] {
  return events
    .filter((event) => STEERING_PATTERNS.some(({ pattern }) => pattern.test(event.text)))
    .map((event) => event.seq);
}
