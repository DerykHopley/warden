import { Observation, type MaskedAgentEvent } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_DESTRUCTIVE_COMMAND,
  AGENT_READS_SECRETS,
  AGENT_SENDS_SECRETS,
  JUDGE_RULES,
} from "./judge-rules.ts";
import { readVerdict, VERDICT_JSON_SCHEMA } from "./judge-verdict.ts";

const HASH = `sha256:${"a".repeat(64)}`;

const events = (count: number): MaskedAgentEvent[] =>
  Array.from({ length: count }, (_, seq) => ({
    seq,
    at: "2026-11-27T10:00:00.000Z",
    name: "PreToolUse",
    tool: "Bash",
    text: `command ${seq}`,
  }));

const read = (verdict: unknown, count = 5) =>
  readVerdict(
    { refusal: false, content: typeof verdict === "string" ? verdict : JSON.stringify(verdict) },
    { sessionId: "sess-1", events: events(count), eventsHash: HASH },
  );

const broken = (rule_id: string, summary: string, event_seqs: number[]) => ({
  rule_id,
  summary,
  event_seqs,
});

describe("readVerdict", () => {
  it("makes one Observation per broken Rule on the session, with the Rule's severity and title and the cited events", () => {
    const outcome = read({ broken_rules: [broken(AGENT_SENDS_SECRETS, "Posted the key", [4, 2])] });

    expect(outcome).toEqual({
      kind: "observations",
      observations: [
        {
          asset: { kind: "agent_session", ref: "sess-1" },
          rule_id: AGENT_SENDS_SECRETS,
          location: { kind: "session" },
          severity: "high",
          title: "The agent sent a secret off the machine",
          evidence: {
            summary: "Posted the key",
            session: { events: [events(5)[2], events(5)[4]], events_read: 5, events_hash: HASH },
          },
        },
      ],
    });
    if (outcome.kind === "observations") Observation.parse(outcome.observations[0]);
  });

  it("answers no Observation when no Rule is broken", () => {
    expect(read({ broken_rules: [] })).toEqual({ kind: "observations", observations: [] });
  });

  it("merges a Rule listed twice into one Observation, with both summaries and the events of both", () => {
    const outcome = read({
      broken_rules: [
        broken(AGENT_READS_SECRETS, "Read .env", [1]),
        broken(AGENT_DESTRUCTIVE_COMMAND, "Ran rm -rf", [3]),
        broken(AGENT_READS_SECRETS, "Read it again", [2, 1]),
      ],
    });

    expect(outcome.kind).toBe("observations");
    if (outcome.kind !== "observations") return;
    expect(outcome.observations.map((o) => o.rule_id)).toEqual([
      AGENT_READS_SECRETS,
      AGENT_DESTRUCTIVE_COMMAND,
    ]);
    const reads = outcome.observations[0]!;
    expect(reads.evidence.summary).toBe("Read .env Read it again");
    expect(reads.evidence.session!.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps at most 50 cited events, the first 50 in session order", () => {
    const cited = Array.from({ length: 70 }, (_, i) => 79 - i);
    const outcome = read({ broken_rules: [broken(AGENT_SENDS_SECRETS, "Many", cited)] }, 80);

    expect(outcome.kind).toBe("observations");
    if (outcome.kind !== "observations") return;
    const session = outcome.observations[0]!.evidence.session!;
    expect(session.events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 10 + i));
    expect(session.events_read).toBe(80);
    Observation.parse(outcome.observations[0]);
  });

  it("cuts a summary over 2,000 characters to 2,000", () => {
    const outcome = read({
      broken_rules: [broken(AGENT_SENDS_SECRETS, "s".repeat(2500), [0])],
    });

    expect(outcome.kind).toBe("observations");
    if (outcome.kind !== "observations") return;
    expect(outcome.observations[0]!.evidence.summary).toHaveLength(2000);
    Observation.parse(outcome.observations[0]);
  });

  it.each([
    ["a refusal", { refusal: true } as const],
    ["content that isn't JSON", { refusal: false, content: "The session looks fine." } as const],
    [
      "content that fails the verdict schema",
      { refusal: false, content: JSON.stringify({ rules: [] }) } as const,
    ],
    [
      "a Rule outside the Judge's",
      {
        refusal: false,
        content: JSON.stringify({ broken_rules: [broken("guard/secret-in-repo", "x", [0])] }),
      } as const,
    ],
    [
      "a cited seq past the events read",
      {
        refusal: false,
        content: JSON.stringify({ broken_rules: [broken(AGENT_SENDS_SECRETS, "x", [5])] }),
      } as const,
    ],
    [
      "a Rule with no cited event",
      {
        refusal: false,
        content: JSON.stringify({ broken_rules: [broken(AGENT_SENDS_SECRETS, "x", [])] }),
      } as const,
    ],
  ])("answers needs_human_review for %s", (_name, answer) => {
    const outcome = readVerdict(answer, {
      sessionId: "sess-1",
      events: events(5),
      eventsHash: HASH,
    });

    expect(outcome).toEqual({ kind: "needs_human_review", reason: expect.any(String) });
  });

  it("names every Judge Rule in the JSON schema the model answers to, and asks for nothing else", () => {
    expect(VERDICT_JSON_SCHEMA).toMatchObject({
      type: "object",
      required: ["broken_rules"],
      additionalProperties: false,
    });
    const item = VERDICT_JSON_SCHEMA.properties.broken_rules.items;
    expect(item.required).toEqual(["rule_id", "summary", "event_seqs"]);
    expect(item.properties.rule_id.enum).toEqual(JUDGE_RULES.map((r) => r.ruleId));
  });
});
