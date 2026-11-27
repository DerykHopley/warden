// Guard's step in the daily Job (spec #225, slice 8a, #499; ADR 0009): for each Team, it deletes the Agent events
// received more than AGENT_EVENT_RETENTION_DAYS ago, then starts one Judge run for each missed session, at most
// JUDGE_SWEEP_LIMIT, oldest end first. The delete runs first, so the sweep never starts a run for events that are
// about to go. It keeps no model key: each run it starts is a Job of its own, which reads its own. Its log lines name
// the Team, never a session id (threat H7). The step's shape is the daily Job's `DailyStep`, written here as Patch's
// refresh writes its own, so the module needn't import the start-up file.
import type { Logger } from "../../log.ts";
import type { JudgeJobStarter } from "../../scans.ts";
import type { AgentSessions } from "./agent-sessions.ts";

/** The most Judge runs one Team's sweep starts in a day; the rest wait for the next day's, oldest first. */
export const JUDGE_SWEEP_LIMIT = 50;

/** The step's counts for one Team, summed over the Teams in the Job's closing line under `steps.guard`. */
export type GuardDailyCounts = {
  eventsDeleted: number;
  judgeRunsStarted: number;
  judgeStartsFailed: number;
};

export interface GuardDailyStep {
  name: string;
  /** `failed` when a missed session's run couldn't be started; a delete or a listing that throws fails it whole. */
  run(team: string): Promise<{ failed: boolean; counts: GuardDailyCounts }>;
}

export function createGuardDailyStep({
  agentSessions,
  startJudgeJob,
  logger,
}: {
  agentSessions: Pick<AgentSessions, "deleteExpiredEvents" | "listMissed">;
  /** Starts one Judge run; undefined in a Cloud Run Job without WARDEN_SCAN_JOB, where none can be started. */
  startJudgeJob: JudgeJobStarter | undefined;
  logger: Logger;
}): GuardDailyStep {
  // Said once per Job, not once per Team: it is the Job's configuration that's missing, not a Team's.
  let saidNoStarter = false;
  return {
    name: "guard",
    async run(team) {
      const eventsDeleted = await agentSessions.deleteExpiredEvents(team);
      const missed = await agentSessions.listMissed(team, JUDGE_SWEEP_LIMIT);
      if (startJudgeJob === undefined) {
        if (missed.length > 0 && !saidNoStarter) {
          saidNoStarter = true;
          logger.error(
            "daily expiry: WARDEN_SCAN_JOB is unset in this Cloud Run Job, so no Judge run can be started for a " +
              "missed Agent session; set it to the Scan Job's name",
          );
        }
        return {
          failed: missed.length > 0,
          counts: { eventsDeleted, judgeRunsStarted: 0, judgeStartsFailed: missed.length },
        };
      }
      let judgeRunsStarted = 0;
      let judgeStartsFailed = 0;
      for (const sessionId of missed) {
        try {
          await startJudgeJob({ sessionId, team });
          judgeRunsStarted += 1;
        } catch (error) {
          judgeStartsFailed += 1;
          logger.error(
            "daily expiry: a Judge run couldn't be started for a missed Agent session; the Team's others still start",
            { team, error },
          );
        }
      }
      return {
        failed: judgeStartsFailed > 0,
        counts: { eventsDeleted, judgeRunsStarted, judgeStartsFailed },
      };
    },
  };
}
