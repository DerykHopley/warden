// Guard's daily step with no Judge starter, as the daily Job wires it in a Cloud Run Job without WARDEN_SCAN_JOB
// (#499), over a fake `agentSessions`. The delete, the sweep and the closing line are tested on a real database in
// daily-expiry.test.ts.
import { describe, expect, it } from "vitest";
import { createLogger } from "../../log.ts";
import { createGuardDailyStep } from "./daily-step.ts";

/** Each Team's missed sessions, and how many events its delete drops. */
function fakeAgentSessions(missedByTeam: Record<string, string[]>, deleted = 3) {
  return {
    deleteExpiredEvents: async () => deleted,
    listMissed: async (team: string) => missedByTeam[team] ?? [],
  };
}

describe("createGuardDailyStep with no Judge starter", () => {
  it("starts nothing, logs WARDEN_SCAN_JOB once per Job, and fails in part each Team with a missed session", async () => {
    const lines: string[] = [];
    const step = createGuardDailyStep({
      agentSessions: fakeAgentSessions({
        org_a: ["sess-a1", "sess-a2"],
        org_b: ["sess-b1"],
      }),
      startJudgeJob: undefined,
      logger: createLogger((line) => lines.push(line)),
    });

    const results = [await step.run("org_a"), await step.run("org_b"), await step.run("org_c")];

    expect(results).toEqual([
      { failed: true, counts: { eventsDeleted: 3, judgeRunsStarted: 0, judgeStartsFailed: 2 } },
      { failed: true, counts: { eventsDeleted: 3, judgeRunsStarted: 0, judgeStartsFailed: 1 } },
      { failed: false, counts: { eventsDeleted: 3, judgeRunsStarted: 0, judgeStartsFailed: 0 } },
    ]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      severity: "ERROR",
      message: expect.stringContaining("WARDEN_SCAN_JOB"),
    });
    for (const sessionId of ["sess-a1", "sess-a2", "sess-b1"]) {
      expect(lines[0]).not.toContain(sessionId);
    }
  });
});
