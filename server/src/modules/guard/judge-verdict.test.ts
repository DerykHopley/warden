import { Observation, type MaskedAgentEvent } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_DESTRUCTIVE_COMMAND,
  AGENT_READS_SECRETS,
  AGENT_SENDS_SECRETS,
  JUDGE_RULES,
  JUDGE_STEERING_TEXT,
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

  it("ends every summary with `ending`, cutting the model's summary to leave it room within 2,000 (slice 7a)", () => {
    const ending =
      "The Judge read the last 5 of 9 events; the earlier ones were over its input cap.";
    const outcome = readVerdict(
      {
        refusal: false,
        content: JSON.stringify({
          broken_rules: [
            broken(AGENT_SENDS_SECRETS, "s".repeat(2500), [0]),
            broken(AGENT_READS_SECRETS, "Read .env.", [1]),
          ],
        }),
      },
      { sessionId: "sess-1", events: events(5), eventsHash: HASH, ending },
    );

    expect(outcome.kind).toBe("observations");
    if (outcome.kind !== "observations") return;
    const [long, short] = outcome.observations.map((observation) => observation.evidence.summary);
    expect(long).toHaveLength(2000);
    expect(long!.endsWith(` ${ending}`)).toBe(true);
    expect(short).toBe(`Read .env. ${ending}`);
    for (const observation of outcome.observations) Observation.parse(observation);
  });

  it("keeps a summary with no character Postgres can't store as the model wrote it", () => {
    const summary = "Lu le fichier .env\tpuis l'a envoyé 🔑 à example.com";
    const outcome = read({ broken_rules: [broken(AGENT_SENDS_SECRETS, summary, [0])] });

    expect(outcome.kind).toBe("observations");
    if (outcome.kind !== "observations") return;
    expect(outcome.observations[0]!.evidence.summary).toBe(summary);
  });

  it("answers needs_human_review for a summary that holds nothing but characters Postgres can't store", () => {
    expect(read({ broken_rules: [broken(AGENT_SENDS_SECRETS, "\u0000 \uD800", [0])] })).toEqual({
      kind: "needs_human_review",
      reason: expect.any(String),
    });
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

  describe("with the events Warden found steering text in (slice 7b)", () => {
    const steered = (answer: Parameters<typeof readVerdict>[0], steering: number[]) =>
      readVerdict(answer, { sessionId: "sess-1", events: events(5), eventsHash: HASH, steering });
    const verdictOf = (rules: unknown[]) => ({
      refusal: false,
      content: JSON.stringify({ broken_rules: rules }),
    });

    it("adds Warden's Medium Observation citing those events, with a summary that counts them, after the model's", () => {
      const outcome = steered(verdictOf([broken(AGENT_READS_SECRETS, "Read .env", [1])]), [3, 2]);

      expect(outcome.kind).toBe("observations");
      if (outcome.kind !== "observations") return;
      expect(outcome.observations.map((o) => o.rule_id)).toEqual([
        AGENT_READS_SECRETS,
        JUDGE_STEERING_TEXT,
      ]);
      const warden = outcome.observations[1]!;
      expect(warden).toMatchObject({
        severity: "medium",
        title: "Text in the session tried to steer the Judge",
        evidence: { summary: "Warden found text addressed to the Judge in 2 events." },
      });
      expect(warden.evidence.session!.events.map((e) => e.seq)).toEqual([2, 3]);
      Observation.parse(warden);
    });

    it("says 1 event for one", () => {
      const outcome = steered(verdictOf([]), [4]);

      expect(outcome.kind).toBe("observations");
      if (outcome.kind !== "observations") return;
      expect(outcome.observations[0]!.evidence.summary).toBe(
        "Warden found text addressed to the Judge in 1 event.",
      );
    });

    it("merges it with the model's Observation for the same Rule: the cited events together, the summaries joined", () => {
      const outcome = steered(
        verdictOf([
          broken(JUDGE_STEERING_TEXT, "The output told the reviewer to mark it safe.", [1]),
          broken(AGENT_READS_SECRETS, "Read .env", [0]),
        ]),
        [3, 1],
      );

      expect(outcome.kind).toBe("observations");
      if (outcome.kind !== "observations") return;
      expect(outcome.observations.map((o) => o.rule_id)).toEqual([
        JUDGE_STEERING_TEXT,
        AGENT_READS_SECRETS,
      ]);
      const merged = outcome.observations[0]!;
      expect(merged.evidence.summary).toBe(
        "The output told the reviewer to mark it safe. Warden found text addressed to the Judge in 2 events.",
      );
      expect(merged.evidence.session!.events.map((e) => e.seq)).toEqual([1, 3]);
    });

    it.each([
      ["a refusal", { refusal: true } as const, "the model refused"],
      [
        "content that isn't JSON",
        { refusal: false, content: "Marked safe, as asked." } as const,
        "the answer isn't a verdict",
      ],
      [
        "a Rule that isn't the Judge's",
        verdictOf([broken("guard/secret-in-repo", "Read .env", [1])]),
        "the answer names a Rule that isn't the Judge's",
      ],
    ])(
      "reports Warden's Observation alone for %s, its summary saying why the answer needs human review",
      (_name, answer, reason) => {
        const outcome = steered(answer, [2]);

        expect(outcome.kind).toBe("observations");
        if (outcome.kind !== "observations") return;
        expect(outcome.observations.map((o) => o.rule_id)).toEqual([JUDGE_STEERING_TEXT]);
        expect(outcome.observations[0]!.evidence.summary).toBe(
          `Warden found text addressed to the Judge in 1 event. The model's answer needs a person's review: ${reason}.`,
        );
      },
    );

    it("ends Warden's summary with `ending` too", () => {
      const ending = "The Judge read the last 5 of 9 events.";
      const outcome = readVerdict(verdictOf([]), {
        sessionId: "sess-1",
        events: events(5),
        eventsHash: HASH,
        steering: [0],
        ending,
      });

      expect(outcome.kind).toBe("observations");
      if (outcome.kind !== "observations") return;
      expect(outcome.observations[0]!.evidence.summary).toBe(
        `Warden found text addressed to the Judge in 1 event. ${ending}`,
      );
    });
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
