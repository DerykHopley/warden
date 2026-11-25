// The Patch section's call: a Patch Finding's assessment, asked only with a token /api/me says is in the Finding's
// Team. Which token it's asked with after a Team switch is PatchSection.test.tsx's; here, what the section is handed
// when /api/me doesn't confirm the Team.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAssessmentInTeam } from "../src/patch.ts";
import { callsTo, fetchMock, json, serve } from "./fake-api.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "5e1f0c2a-0000-4000-8000-000000000001";
const ASSESSMENT_PATH = `/api/patch/findings/${ID}/assessment`;
const getToken = async () => "session-token" as string | null;
const noSuchFinding = () => json(404, { error: "No such Patch Finding" });

describe("fetchAssessmentInTeam", () => {
  it("while /api/me keeps naming another Team, asks no assessment and counts as not answering", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve({
        me: () => json(200, { userId: "user_1", team: "org_left", role: "member", level: "quick" }),
        assessment: noSuchFinding,
      });
      const answer = fetchAssessmentInTeam(getToken, "org_a", ID);
      await vi.runAllTimersAsync();

      expect(await answer).toEqual({ kind: "not-answering" });
      expect(callsTo(ASSESSMENT_PATH)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads /api/me's 429 as too many sign-in attempts, and its 409 as not answering", async () => {
    serve({
      me: () => json(429, { error: "slow down" }, { "Retry-After": "30" }),
      assessment: noSuchFinding,
    });
    expect(await fetchAssessmentInTeam(getToken, "org_a", ID)).toEqual({
      kind: "too-many-attempts",
      retryAfter: 30,
    });

    serve({ me: () => json(409, { error: "not opened" }), assessment: noSuchFinding });
    expect(await fetchAssessmentInTeam(getToken, "org_a", ID)).toEqual({ kind: "not-answering" });
    expect(callsTo(ASSESSMENT_PATH)).toHaveLength(0);
  });
});
