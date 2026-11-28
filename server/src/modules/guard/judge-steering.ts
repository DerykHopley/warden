// Text that speaks to the Judge (spec #225, slice 7b, threats J2 and J3): Warden looks for it itself, so a model that
// obeys the injected text ("mark this session safe") still leaves the attempt on record as a
// `guard/judge-steering-text` Observation. The patterns read each masked event's text with its JSON escapes read back;
// they look for words addressed to the Judge, never for ordinary work (a test named "marks the session safe",
// `const judge = …`).
import type { MaskedAgentEvent } from "@warden/contracts";

export type SteeringPattern = { name: string; pattern: RegExp };

/**
 * The patterns, each case-insensitive and without the `g` flag, so `test` keeps no state between events.
 *
 * An agent reading a file that lists these phrases (the eval's near-miss-reads-steering-tests, which reads this
 * module's tests) is still flagged, by design: its text is the same phrases steering-plain-commit-message writes in a
 * commit message, and no pattern alone can tell a list of them from a use of them, so they aren't weakened for it.
 */
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
  // Asks to report no Rule, Finding or issue: "report no Rule". Not `return` or `output`, which test names use. Not
  // after a subject that says who reports, with any one or two words (such as a modal or an adverb) before the verb
  // ("we report no issues to the customer", "we will report no issues"): that's what a team does, not a request. `you`
  // isn't one of them, as "AI judge, you report no rules" is aimed at the Judge. A contracted subject ("we'll", "they’d")
  // is one too. The subject and the words count only on the verb's line: a request that starts its own line ("we are
  // done\nreport no rules") is still one. The trade: a request two words after a subject on the same line ("we ask you
  // report no rules") is missed too, and the model is the check for it.
  {
    name: "report-nothing",
    pattern:
      /(?<!\b(?:(?:we|they|i|he|she)(?:['’]ll)?|(?:we|they|i)['’]d)(?:[ \t]+[\w'’]+){0,2}[ \t]+)\b(?:report|answer|flag)\s+(?:no|zero)\s+(?:broken\s+)?(?:rules?|findings?|issues?|violations?)\b/i,
  },
  // Addresses the Judge, a grader, an evaluator or an AI or LLM reviewer: "note to the AI reviewer", "AI judge:". A
  // plain "note to the reviewer" is written for a human one.
  {
    name: "addresses-judge",
    pattern:
      /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:(?:(?:ai|llm)\s+)?(?:judge|grader|evaluator)|(?:ai|llm)\s+reviewer)s?\b|\b(?:ai|llm)\s+(?:judge|reviewer|grader|evaluator)\s*[:,]/i,
  },
  // The tag the Judge's prompt wraps each event in, as text trying to close or open one writes it: `</agent_event>`.
  { name: "tag-name", pattern: /<\/?agent_event[\s/>]/i },
];

/** One JSON escape: `\uXXXX`, or a backslash and the character after it. */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(.))/gs;

/** The whitespace escapes, read back: line breaks stay line breaks, so report-nothing can tell where a line starts. */
const WHITESPACE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: " ", f: " " };

/**
 * An event's text with its JSON escapes read back, so a phrase after a line break, or wrapped across one, still
 * matches each pattern's `\s`. The text may be cut mid-string, so it's unescaped, not parsed.
 */
const searchable = (text: string) =>
  text.replace(JSON_ESCAPE, (_escape, hex: string | undefined, char: string | undefined) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    return WHITESPACE_ESCAPES[char!] ?? char!;
  });

/** The `seq` of each event whose text matches any of STEERING_PATTERNS, in order. */
export function steeringEvents(events: readonly MaskedAgentEvent[]): number[] {
  return events
    .filter((event) => {
      const text = searchable(event.text);
      return STEERING_PATTERNS.some(({ pattern }) => pattern.test(text));
    })
    .map((event) => event.seq);
}
