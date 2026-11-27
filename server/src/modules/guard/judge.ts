// The Judge (spec #225, slice 5a, story 9): one run over one ended Agent session. It reads the session's events once,
// masks them as the contracts' `MaskedAgentEvent`, asks the model which of the Judge's Rules they break, reports
// one Guard Spot run with an Observation per broken Rule, then marks the session judged and drops the events it read.
// A run that throws (the model call, the report, the mark) leaves the session unjudged with its events, for a retry;
// a retry over the same events reports the same Spot run, which changes nothing the second time. A session's outcome
// never moves down (OUTCOME_ORDER), so a later run over its late events keeps what an earlier one found.
//
// Its spending safeguards (slice 7a, story 10, threat J5): a run claims its session first, so two runs started at once
// make one call; it reads only the last events whose prompt fits JUDGE_INPUT_TOKEN_CAP, and still drops every event it
// loaded; it makes at most JUDGE_RUN_CALL_BUDGET calls (a failed call, ModelCallFailed, gets one retry); and before each
// paid call it checks the Team's spending today against TEAM_DAILY_SPENDING_LIMIT_USD, recording each paid call made
// in the spending ledger. A Team's own model costs Warden nothing: neither checked nor recorded.
import { agentEventsHash, Status, type SpotRun } from "@warden/contracts";
import type { Findings } from "../../findings/index.ts";
import {
  TEAM_DAILY_SPENDING_LIMIT_USD,
  UNPRICED_CALL_USD,
  type Spending,
  type SpendingEntry,
} from "../../spending.ts";
import type { AgentSessions, SessionOutcome } from "./agent-sessions.ts";
import {
  ModelCallFailed,
  type ChatMessage,
  type JudgeModel,
  type ModelAnswer,
  type ModelUsage,
} from "./judge-model.ts";
import { judgePrompt, lastEventsThatFit, maskEvents } from "./judge-prompt.ts";
import { JUDGE_RULES } from "./judge-rules.ts";
import { readVerdict, VERDICT_JSON_SCHEMA } from "./judge-verdict.ts";

/** The verdict schema's name in the request's `response_format`. */
const VERDICT_SCHEMA_NAME = "judge_verdict";

/** The most model calls one run makes: the call, and one retry when it fails. */
export const JUDGE_RUN_CALL_BUDGET = 2;

/**
 * What one run did: nothing (no ended session with events); nothing, as another run holds the session; nothing, as the
 * Team's spending today reached its limit; or the session's outcome, with the events it read and those it cut.
 */
export type JudgeRunOutcome =
  | { kind: "skipped" }
  | { kind: "busy" }
  | { kind: "limited"; spent: number }
  | {
      kind: "judged";
      outcome: SessionOutcome;
      eventsRead: number;
      eventsCut: number;
      opened: number;
    };

export interface Judge {
  /** One run over the Team's session `sessionId`; it throws when the session must stay unjudged. */
  run(team: string, sessionId: string): Promise<JudgeRunOutcome>;
}

/** Whether the Spot run `spotRunId`, already applied, opened or saw a Finding: a Judge Finding of any Status. */
async function appliedRunFlagged(
  findings: Pick<Findings, "listByRules">,
  team: string,
  spotRunId: string,
): Promise<boolean> {
  const judged = await findings.listByRules(team, {
    rules: JUDGE_RULES.map((rule) => rule.ruleId),
    statuses: Status.options,
  });
  return judged.some(
    (finding) => finding.first_seen_scan === spotRunId || finding.last_seen_scan === spotRunId,
  );
}

/** The ledger entry for a paid call that answered: the cost it stated, or UNPRICED_CALL_USD when it stated none. */
function answeredEntry(model: string, usage: ModelUsage | undefined): SpendingEntry {
  const tokens = {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
  return usage?.costUsd === undefined
    ? { path: "judge", model, ...tokens, costUsd: UNPRICED_CALL_USD, costBasis: "assumed" }
    : { path: "judge", model, ...tokens, costUsd: usage.costUsd, costBasis: "stated" };
}

/** What a run's Finding summaries end with when it read only the session's last events. */
const cutEnding = (read: number, total: number) =>
  `The Judge read the last ${read} of ${total} events; the earlier ones were over its input cap.`;

/**
 * `modelFor` gives the Team's model, asked only when there is a session to judge: its own (slice 6a) or OpenRouter's.
 * `spending` is the Team's ledger, read and added to only for a paid model.
 */
export function createJudge({
  agentSessions,
  findings,
  spending,
  modelFor,
}: {
  agentSessions: Pick<AgentSessions, "claim" | "release" | "readEnded" | "markJudged">;
  findings: Pick<Findings, "report" | "listByRules">;
  spending: Spending;
  modelFor: (team: string) => Promise<JudgeModel>;
}): Judge {
  /**
   * The model's answer within the run's call budget, or the Team's spending when it reached the limit before a paid
   * call. A failed paid call is recorded at UNPRICED_CALL_USD before the retry's check, so the check counts it.
   */
  async function complete(
    team: string,
    model: JudgeModel,
    messages: ChatMessage[],
  ): Promise<{ answer: ModelAnswer } | { limited: number }> {
    for (let call = 1; ; call++) {
      if (model.paid) {
        const spent = await spending.spentToday(team);
        if (spent >= TEAM_DAILY_SPENDING_LIMIT_USD) return { limited: spent };
      }
      try {
        const answer = await model.complete(messages, {
          name: VERDICT_SCHEMA_NAME,
          schema: VERDICT_JSON_SCHEMA,
        });
        if (model.paid) await spending.record(team, answeredEntry(model.model, answer.usage));
        return { answer };
      } catch (error) {
        // Anything else (no key: ConfigError) never left the machine, and a retry would fail the same way.
        if (!(error instanceof ModelCallFailed)) throw error;
        if (model.paid) await spending.record(team, answeredEntry(model.model, undefined));
        if (call >= JUDGE_RUN_CALL_BUDGET) throw error;
      }
    }
  }

  /** The run, once its session is claimed. */
  async function judgeClaimed(team: string, sessionId: string): Promise<JudgeRunOutcome> {
    const read = await agentSessions.readEnded(team, sessionId);
    if (read === undefined) return { kind: "skipped" };

    const kept = lastEventsThatFit(read);
    const eventsCut = read.length - kept.length;
    const events = maskEvents(kept);
    const eventsHash = await agentEventsHash(events);
    const { system, user } = judgePrompt(events);
    const model = await modelFor(team);
    const called = await complete(team, model, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    if ("limited" in called) return { kind: "limited", spent: called.limited };
    const verdict = readVerdict(called.answer, {
      sessionId,
      events,
      eventsHash,
      ...(eventsCut > 0 ? { ending: cutEnding(kept.length, read.length) } : {}),
    });

    let outcome: SessionOutcome = "needs_human_review";
    let opened = 0;
    if (verdict.kind === "observations") {
      // The same events give the same id and start, so a retry's report is already applied.
      const spotRun: SpotRun = {
        id: `judge-${sessionId}-${eventsHash.slice("sha256:".length)}`,
        team,
        module: "guard",
        started_at: read.at(-1)!.receivedAt.toISOString(),
        observations: verdict.observations,
      };
      const reported = await findings.report(spotRun);
      opened = reported.opened.length;
      // A retry's answer may differ from the one already applied, which this report then dropped: the Findings
      // that applied run opened or saw say the outcome.
      const flagged = reported.alreadyApplied
        ? await appliedRunFlagged(findings, team, spotRun.id)
        : verdict.observations.length > 0;
      outcome = flagged ? "flagged" : "clean";
    }

    // Every event loaded, the cut ones too: they were over the cap, and a later run would cut them again.
    const marked = await agentSessions.markJudged(team, sessionId, {
      outcome,
      rowSeqs: read.map((event) => event.rowSeq),
    });
    return { kind: "judged", outcome: marked, eventsRead: kept.length, eventsCut, opened };
  }

  return {
    async run(team, sessionId) {
      const claim = await agentSessions.claim(team, sessionId);
      if (claim === "busy") return { kind: "busy" };
      if (claim === "absent") return { kind: "skipped" };
      let ran: JudgeRunOutcome;
      try {
        ran = await judgeClaimed(team, sessionId);
      } catch (error) {
        // The run's own error is the one to report; a claim not cleared runs out after JUDGE_CLAIM_MINUTES.
        await agentSessions.release(team, sessionId).catch(() => undefined);
        throw error;
      }
      if (ran.kind !== "judged") await agentSessions.release(team, sessionId);
      return ran;
    },
  };
}
