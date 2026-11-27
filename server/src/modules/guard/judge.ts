// The Judge (spec #225, slice 5a, story 9): one run over one ended Agent session. It reads the session's events once,
// masks them as the contracts' `MaskedAgentEvent`, asks the model once which of the Judge's Rules they break, reports
// one Guard Spot run with an Observation per broken Rule, then marks the session judged and drops the events it read.
// A run that throws (the model call, the report, the mark) leaves the session unjudged with its events, for a retry;
// a retry over the same events reports the same Spot run, which changes nothing the second time. A session's outcome
// never moves down (OUTCOME_ORDER), so a later run over its late events keeps what an earlier one found.
import { agentEventsHash, Status, type SpotRun } from "@warden/contracts";
import type { Findings } from "../../findings/index.ts";
import type { AgentSessions, SessionOutcome } from "./agent-sessions.ts";
import type { JudgeModel } from "./judge-model.ts";
import { judgePrompt, maskEvents } from "./judge-prompt.ts";
import { JUDGE_RULES } from "./judge-rules.ts";
import { readVerdict, VERDICT_JSON_SCHEMA } from "./judge-verdict.ts";

/** The verdict schema's name in the request's `response_format`. */
const VERDICT_SCHEMA_NAME = "judge_verdict";

/** What one run did: nothing (no ended session with events), or the session's outcome. */
export type JudgeRunOutcome =
  | { kind: "skipped" }
  | { kind: "judged"; outcome: SessionOutcome; eventsRead: number; opened: number };

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

/**
 * `modelFor` gives the Team's model, asked only when there is a session to judge: its own (slice 6a) or OpenRouter's.
 */
export function createJudge({
  agentSessions,
  findings,
  modelFor,
}: {
  agentSessions: Pick<AgentSessions, "readEnded" | "markJudged">;
  findings: Pick<Findings, "report" | "listByRules">;
  modelFor: (team: string) => Promise<JudgeModel>;
}): Judge {
  return {
    async run(team, sessionId) {
      const read = await agentSessions.readEnded(team, sessionId);
      if (read === undefined) return { kind: "skipped" };

      const events = maskEvents(read);
      const eventsHash = await agentEventsHash(events);
      const { system, user } = judgePrompt(events);
      const model = await modelFor(team);
      const answer = await model.complete(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { name: VERDICT_SCHEMA_NAME, schema: VERDICT_JSON_SCHEMA },
      );
      const verdict = readVerdict(answer, { sessionId, events, eventsHash });

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

      const marked = await agentSessions.markJudged(team, sessionId, {
        outcome,
        rowSeqs: read.map((event) => event.rowSeq),
      });
      return { kind: "judged", outcome: marked, eventsRead: read.length, opened };
    },
  };
}
