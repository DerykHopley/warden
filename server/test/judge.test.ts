// One Judge run (spec #225, slice 5a): the Scan Job's run for one ended Agent session, as `scan-job.ts` runs it with the
// Judge `wiring.ts` builds, on the suite's shared database, with OpenRouter faked at its HTTP boundary. Each case has a
// Team and a session of its own, with events stored as the hook endpoint stores them.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { judgeSettings, type JudgeSettings } from "../src/config.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import {
  createAgentSessions,
  type AgentSessions,
  type AgentSessionTables,
  type SessionOutcome,
} from "../src/modules/guard/agent-sessions.ts";
import { createJudge } from "../src/modules/guard/judge.ts";
import { openRouterModel } from "../src/modules/guard/judge-model.ts";
import { AGENT_READS_SECRETS, AGENT_SENDS_SECRETS } from "../src/modules/guard/judge-rules.ts";
import { runJudgeJob } from "../src/scan-job.ts";
import { judge, MOVE_RULES } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  completion,
  fakeOpenRouter,
  neverAnswers,
  verdict,
  type FakeCall,
} from "./fake-openrouter.ts";
import { logEntries, newTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let sessions: AgentSessions;
let findings: Findings;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  sessions = createAgentSessions({ withTeam });
  findings = createFindings({ withTeam, moveRules: MOVE_RULES });
});

afterAll(() => pool.end());

const KEY = `sk-or-v1-${randomUUID()}`;

/** The settings the Job reads with the key set. */
const settings = judgeSettings({ OPENROUTER_API_KEY: KEY });

/** Stores one event for the session, as the hook endpoint does. */
const store = (
  team: string,
  sessionId: string,
  name: string,
  fields: Record<string, string> = {},
) =>
  sessions.store(team, {
    sessionId,
    name,
    tool: fields.tool_name ?? null,
    fields: { hook_event_name: name, ...fields },
    developer: null,
    ended: name === "SessionEnd",
    refusedEvents: 0,
  });

/** A Team with one session of three events: its start, reading .env, then its end unless `ended` is false. */
async function teamWithSession({ ended = true }: { ended?: boolean } = {}) {
  const team = await newTeam(withTeam);
  const sessionId = `sess-${randomUUID()}`;
  await store(team, sessionId, "SessionStart", { source: "startup" });
  await store(team, sessionId, "PostToolUse", { tool_name: "Read", tool_use_id: "toolu_1" });
  if (ended) await store(team, sessionId, "SessionEnd", { reason: "exit" });
  return { team, sessionId };
}

/** The session's row and its events' names, read as the Team. */
const sessionState = (team: string, sessionId: string) =>
  withTeam(team, async (tx) => {
    const db = tx.$extendTables<AgentSessionTables>();
    const session = await db
      .selectFrom("agent_sessions")
      .select(["judged_at", "outcome"])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    const events = await db
      .selectFrom("agent_events")
      .select(["name", "received_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq")
      .execute();
    return { session, events };
  });

/** One run of the Job for the session, with the Judge wired as the Job wires it; its exit code and log lines. */
async function runJob(
  team: string,
  sessionId: string,
  fetch: ReturnType<typeof fakeOpenRouter>["fetch"],
  options: { settings?: JudgeSettings; timeoutMs?: number } = {},
) {
  const lines: string[] = [];
  const code = await runJudgeJob({
    team,
    sessionId,
    judge: judge({
      withTeam,
      settings: options.settings ?? settings,
      fetch,
      timeoutMs: options.timeoutMs,
    }),
    logger: createLogger((line) => lines.push(line)),
  });
  return { code, lines, entries: logEntries(lines.join("")) };
}

const unjudged = { judged_at: null, outcome: null };

describe("a Judge run", () => {
  it("drops the events it read and marks the session flagged, keeping an event stored while the model answered", async () => {
    const { team, sessionId } = await teamWithSession();
    const fake = fakeOpenRouter(async () => {
      await store(team, sessionId, "PostToolUse", { tool_name: "Read" });
      return verdict([{ rule_id: AGENT_READS_SECRETS, summary: "Read .env", event_seqs: [1] }]);
    });

    const { code } = await runJob(team, sessionId, fake.fetch);

    expect(code).toBe(0);
    const { session, events } = await sessionState(team, sessionId);
    expect(session).toEqual({ judged_at: expect.any(Date), outcome: "flagged" });
    expect(events.map((e) => e.name)).toEqual(["PostToolUse"]);
    expect((await findings.list(team)).map((f) => f.rule_id)).toEqual([AGENT_READS_SECRETS]);
  });

  it("saves a Finding whose summary drops the NUL and the lone surrogate Postgres can't store, and marks the session judged", async () => {
    const { team, sessionId } = await teamWithSession();
    const fake = fakeOpenRouter(() =>
      verdict([
        { rule_id: AGENT_READS_SECRETS, summary: "Read\u0000 .env\uDC00 twice", event_seqs: [1] },
      ]),
    );

    const { code } = await runJob(team, sessionId, fake.fetch);

    expect(code).toBe(0);
    expect((await sessionState(team, sessionId)).session).toEqual({
      judged_at: expect.any(Date),
      outcome: "flagged",
    });
    const [finding] = await findings.list(team);
    expect(finding!.evidence.summary).toBe("Read .env twice");
  });

  it("opens no Finding for a clean session, drops its events, and records a Guard Spot run at its start", async () => {
    const { team, sessionId } = await teamWithSession();
    const before = await sessionState(team, sessionId);
    const fake = fakeOpenRouter(() => verdict([]));

    const { code, entries } = await runJob(team, sessionId, fake.fetch);

    expect(code).toBe(0);
    expect(await findings.list(team)).toEqual([]);
    expect(await sessionState(team, sessionId)).toEqual({
      session: { judged_at: expect.any(Date), outcome: "clean" },
      events: [],
    });
    expect(await findings.lastSpotRunAt(team, { module: "guard", since: new Date(0) })).toBe(
      before.events.at(-1)!.received_at.toISOString(),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        severity: "INFO",
        team,
        outcome: "clean",
        eventsRead: 3,
        opened: 0,
      }),
    );
  });

  it("opens no second Finding and adds no history when run again over the same events after its report applied", async () => {
    const { team, sessionId } = await teamWithSession();
    const fake = fakeOpenRouter(() =>
      verdict([{ rule_id: AGENT_SENDS_SECRETS, summary: "Sent the key", event_seqs: [1, 2] }]),
    );
    // The first run's events aren't dropped: its mark fails after its report applied.
    let failMark = true;
    const failingOnce: AgentSessions = {
      ...sessions,
      markJudged: (...args) => {
        if (failMark) {
          failMark = false;
          return Promise.reject(new Error("the database went away"));
        }
        return sessions.markJudged(...args);
      },
    };
    const run = () =>
      createJudge({
        agentSessions: failingOnce,
        findings,
        modelFor: () =>
          Promise.resolve(
            openRouterModel({ apiKey: KEY, model: settings.model, fetch: fake.fetch }),
          ),
      }).run(team, sessionId);

    await expect(run()).rejects.toThrow("the database went away");
    const [opened] = await findings.list(team);
    const history = await findings.history(team, opened!.id);
    expect((await sessionState(team, sessionId)).events).toHaveLength(3);

    await expect(run()).resolves.toMatchObject({ kind: "judged", outcome: "flagged", opened: 0 });

    expect(await findings.list(team)).toEqual([opened]);
    expect(await findings.history(team, opened!.id)).toEqual(history);
    expect(await sessionState(team, sessionId)).toEqual({
      session: { judged_at: expect.any(Date), outcome: "flagged" },
      events: [],
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("marks the session flagged when its retry's answer lists no Rule but its first report already opened a Finding", async () => {
    const { team, sessionId } = await teamWithSession();
    const answers = [
      verdict([{ rule_id: AGENT_SENDS_SECRETS, summary: "Sent the key", event_seqs: [1] }]),
      verdict([]),
    ];
    const fake = fakeOpenRouter(() => answers.shift());
    let failMark = true;
    const failingOnce: AgentSessions = {
      ...sessions,
      markJudged: (...args) => {
        if (failMark) {
          failMark = false;
          return Promise.reject(new Error("the database went away"));
        }
        return sessions.markJudged(...args);
      },
    };
    const run = () =>
      createJudge({
        agentSessions: failingOnce,
        findings,
        modelFor: () =>
          Promise.resolve(
            openRouterModel({ apiKey: KEY, model: settings.model, fetch: fake.fetch }),
          ),
      }).run(team, sessionId);

    await expect(run()).rejects.toThrow("the database went away");
    await expect(run()).resolves.toMatchObject({ kind: "judged", outcome: "flagged", opened: 0 });

    expect((await sessionState(team, sessionId)).session).toEqual({
      judged_at: expect.any(Date),
      outcome: "flagged",
    });
    expect((await findings.list(team)).map((f) => [f.rule_id, f.status])).toEqual([
      [AGENT_SENDS_SECRETS, "open"],
    ]);
  });

  /** An answer that gives each outcome, citing event 0, which every run reads. */
  const answerFor: Record<SessionOutcome, () => unknown> = {
    flagged: () =>
      verdict([{ rule_id: AGENT_READS_SECRETS, summary: "Read .env", event_seqs: [0] }]),
    needs_human_review: () => completion(null, "I can't help with that."),
    clean: () => verdict([]),
  };

  it.each<[SessionOutcome, SessionOutcome, SessionOutcome]>([
    ["flagged", "clean", "flagged"],
    ["flagged", "needs_human_review", "flagged"],
    ["needs_human_review", "clean", "needs_human_review"],
    ["clean", "needs_human_review", "needs_human_review"],
    ["clean", "flagged", "flagged"],
  ])(
    "a %s session whose late events a later run judges %s ends %s: an outcome never moves down",
    async (first, second, expected) => {
      const { team, sessionId } = await teamWithSession();
      await runJob(team, sessionId, fakeOpenRouter(answerFor[first]).fetch);
      await store(team, sessionId, "PostToolUse", { tool_name: "Read" });

      const { code, entries } = await runJob(
        team,
        sessionId,
        fakeOpenRouter(answerFor[second]).fetch,
      );

      expect(code).toBe(0);
      expect(await sessionState(team, sessionId)).toEqual({
        session: { judged_at: expect.any(Date), outcome: expected },
        events: [],
      });
      expect(entries).toContainEqual(
        expect.objectContaining({ team, outcome: expected, eventsRead: 1 }),
      );
    },
  );

  it.each<[string, (call: FakeCall) => unknown]>([
    ["a refusal", () => completion(null, "I can't help with that.")],
    ["no content", () => completion(null)],
    ["content that isn't JSON", () => completion("The session looks fine to me.")],
    [
      "a Rule outside the Judge's",
      () => verdict([{ rule_id: "guard/secret-in-repo", summary: "x", event_seqs: [0] }]),
    ],
    [
      "a cited seq past the events read",
      () => verdict([{ rule_id: AGENT_SENDS_SECRETS, summary: "x", event_seqs: [3] }]),
    ],
  ])(
    "ends the session needs_human_review, opening no Finding and dropping its events, for %s",
    async (_name, answer) => {
      const { team, sessionId } = await teamWithSession();
      const fake = fakeOpenRouter(answer);

      const { code, entries } = await runJob(team, sessionId, fake.fetch);

      expect(code).toBe(0);
      expect(await findings.list(team)).toEqual([]);
      expect(await sessionState(team, sessionId)).toEqual({
        session: { judged_at: expect.any(Date), outcome: "needs_human_review" },
        events: [],
      });
      expect(
        await findings.lastSpotRunAt(team, { module: "guard", since: new Date(0) }),
      ).toBeNull();
      expect(entries).toContainEqual(
        expect.objectContaining({ team, outcome: "needs_human_review", eventsRead: 3, opened: 0 }),
      );
    },
  );
});

describe("a Judge run that fails", () => {
  it.each<[string, (call: FakeCall, init: RequestInit) => unknown]>([
    ["a model call answering 500", () => new Response("upstream error", { status: 500 })],
    ["a model call that times out", neverAnswers],
  ])(
    "leaves the session unjudged with all its events and no Finding, and exits 1, for %s",
    async (_name, answer) => {
      const { team, sessionId } = await teamWithSession();
      const before = await sessionState(team, sessionId);
      const fake = fakeOpenRouter(answer);

      const { code, entries } = await runJob(team, sessionId, fake.fetch, { timeoutMs: 50 });

      expect(code).toBe(1);
      expect(fake.calls).toHaveLength(1);
      expect(await sessionState(team, sessionId)).toEqual({ ...before, session: unjudged });
      expect(await findings.list(team)).toEqual([]);
      expect(entries).toContainEqual(expect.objectContaining({ severity: "ERROR", team }));
    },
  );

  it("makes no call with OPENROUTER_API_KEY unset, leaves the session as it was, exits 1 and names the variable", async () => {
    const { team, sessionId } = await teamWithSession();
    const before = await sessionState(team, sessionId);
    const fake = fakeOpenRouter(() => verdict([]));

    const { code, entries } = await runJob(team, sessionId, fake.fetch, {
      settings: judgeSettings({ OPENROUTER_API_KEY: "" }),
    });

    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(await sessionState(team, sessionId)).toEqual({ ...before, session: unjudged });
    expect(await findings.list(team)).toEqual([]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        message: expect.stringContaining("OPENROUTER_API_KEY"),
        variables: ["OPENROUTER_API_KEY"],
      }),
    );
  });
});

describe("a Judge run with nothing to judge", () => {
  it("changes nothing and makes no call for another Team's session", async () => {
    const { team, sessionId } = await teamWithSession();
    const teamB = await newTeam(withTeam);
    const before = await sessionState(team, sessionId);
    const fake = fakeOpenRouter(() => verdict([]));

    const { code } = await runJob(teamB, sessionId, fake.fetch);

    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(await sessionState(team, sessionId)).toEqual({ ...before, session: unjudged });
    expect(await findings.list(teamB)).toEqual([]);
  });

  it("changes nothing and makes no call for a session with no SessionEnd yet", async () => {
    const { team, sessionId } = await teamWithSession({ ended: false });
    const before = await sessionState(team, sessionId);
    const fake = fakeOpenRouter(() => verdict([]));

    const { code } = await runJob(team, sessionId, fake.fetch);

    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(await sessionState(team, sessionId)).toEqual({ ...before, session: unjudged });
  });

  it("changes nothing and makes no call for a session already judged, whose events are dropped", async () => {
    const { team, sessionId } = await teamWithSession();
    await runJob(team, sessionId, fakeOpenRouter(() => verdict([])).fetch);
    const before = await sessionState(team, sessionId);
    const fake = fakeOpenRouter(() => verdict([]));

    const { code } = await runJob(team, sessionId, fake.fetch);

    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(await sessionState(team, sessionId)).toEqual(before);
  });
});
