// Setup's Catalogue switch (spec #341, slice 5), sent only with a token /api/me says is in the Team Setup was opened
// in, as a Product save is. What the section shows for each answer is Setup.test.tsx's. Then the Control card's lines
// (slice 7a): the reason under the Verdict, each Rule's evidence, the Judge run's, and a review's outcome.
import type { ControlReview, ControlRuleEvidence } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAndTimeWords } from "../src/date-words.ts";
import {
  judgeRunLine,
  reviewOutcomeLine,
  ruleEvidenceWords,
  switchCatalogueInTeam,
  verdictReasonLine,
} from "../src/vouch.ts";
import { callsTo, fetchMock, json, serve } from "./fake-api.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "vda-isa-2027.1";
const PATH = `/api/vouch/catalogues/${ID}`;
const getToken = async () => "session-token" as string | null;
const inTeam =
  (team = "org_a") =>
  () =>
    json(200, { userId: "user_1", team, role: "admin", level: "quick" });
const CATALOGUE = {
  id: ID,
  name: "VDA ISA 2027.1",
  date: "2026-09-30",
  credit: "© 2026 ENX Association.",
  licence: "CC BY-ND 4.0",
  licence_url: "https://creativecommons.org/licenses/by-nd/4.0/",
  on: true,
  set_by: "user_1",
  set_at: "2026-11-26T09:14:00.000Z",
  controls: [{ ref: "1.3.3", question: "Is it?", iso_27001: "A.5.1" }],
};

describe("switchCatalogueInTeam", () => {
  it("sends the PUT with the token /api/me confirmed the Team with", async () => {
    let tokens = 0;
    const freshTokens = async () => `token-${++tokens}` as string | null;
    serve({ me: inTeam(), switchCatalogue: () => json(200, CATALOGUE) });

    expect(await switchCatalogueInTeam(freshTokens, "org_a", ID, true)).toEqual({
      kind: "switched",
      catalogue: CATALOGUE,
    });
    expect(callsTo(PATH)).toHaveLength(1);
    const init = callsTo(PATH)[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("while /api/me names another Team, sends no PUT and counts as not answering", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve({ me: inTeam("org_left"), switchCatalogue: () => json(200, CATALOGUE) });
      const answer = switchCatalogueInTeam(getToken, "org_a", ID, true);
      await vi.runAllTimersAsync();

      expect(await answer).toEqual({ kind: "not-answering" });
      expect(callsTo(PATH)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back the Team check's own refusals: too many sign-ins, a Team not opened", async () => {
    serve({ me: () => json(429, {}, { "Retry-After": "30" }) });
    expect(await switchCatalogueInTeam(getToken, "org_a", ID, true)).toEqual({
      kind: "too-many-sign-ins",
      retryAfter: 30,
    });
    serve({ me: () => json(409, { error: "not opened" }) });
    expect(await switchCatalogueInTeam(getToken, "org_a", ID, true)).toEqual({
      kind: "team-not-opened",
    });
    expect(callsTo(PATH)).toHaveLength(0);
  });
});

const COVERED_AT = "2026-11-24T09:14:00.000Z";
const rule = (fields: Partial<ControlRuleEvidence> = {}): ControlRuleEvidence => ({
  rule_id: "guard/unapproved-ai-tool",
  asset_kind: "repo",
  last_covered_at: COVERED_AT,
  assets_covered: 2,
  assets_held: 3,
  ...fields,
});

describe("ruleEvidenceWords (story 3)", () => {
  it("says when a covered Rule was last covered, and on how many of the Team's Repos", () => {
    expect(ruleEvidenceWords(rule())).toBe(
      `last covered ${dayAndTimeWords(COVERED_AT)}, on 2 of 3 Repos`,
    );
  });

  it("says no Scan covered it in 30 days when none did", () => {
    expect(ruleEvidenceWords(rule({ last_covered_at: null, assets_covered: 0 }))).toBe(
      "no Scan in the last 30 days, on 0 of 3 Repos",
    );
  });

  it("counts Products for a Product Rule", () => {
    expect(ruleEvidenceWords(rule({ rule_id: "patch/known-cve", asset_kind: "product" }))).toBe(
      `last covered ${dayAndTimeWords(COVERED_AT)}, on 2 of 3 Products`,
    );
  });

  it("names one Asset in the singular", () => {
    expect(ruleEvidenceWords(rule({ assets_covered: 1, assets_held: 1 }))).toBe(
      `last covered ${dayAndTimeWords(COVERED_AT)}, on 1 of 1 Repo`,
    );
    expect(
      ruleEvidenceWords(rule({ asset_kind: "product", assets_covered: 0, assets_held: 1 })),
    ).toBe(`last covered ${dayAndTimeWords(COVERED_AT)}, on 0 of 1 Product`);
  });
});

describe("judgeRunLine (story 3, 5.2.4)", () => {
  it("gives the newest Judge run's day and time", () => {
    expect(judgeRunLine(COVERED_AT)).toBe(`Last Judge run: ${dayAndTimeWords(COVERED_AT)}`);
  });

  it("says none ran in 30 days when none did", () => {
    expect(judgeRunLine(null)).toBe("No Judge run in the last 30 days.");
  });
});

describe("verdictReasonLine (story 2)", () => {
  const REASON = "No Scan covered it in the last 30 days";

  it.each([
    ["not reviewed", { review_state: "not_reviewed", reviewed_verdict: null }],
    ["confirmed", { review_state: "reviewed", reviewed_verdict: "not_evidenced" }],
    ["changed since review", { review_state: "changed_since_review", reviewed_verdict: null }],
  ] as const)("is the reason as the server gives it while %s", (_, fields) => {
    expect(verdictReasonLine({ verdict: "not_evidenced", reason: REASON, ...fields })).toBe(REASON);
  });

  it("names the worked-out Verdict it explains while a reviewed one replaces it", () => {
    expect(
      verdictReasonLine({
        verdict: "not_evidenced",
        reason: REASON,
        review_state: "reviewed",
        reviewed_verdict: "not_applicable",
      }),
    ).toBe(`Worked out as Not evidenced: ${REASON}`);
  });
});

const review = (fields: Partial<ControlReview> = {}): ControlReview => ({
  id: "r-1",
  worked_out_verdict: "partly_evidenced",
  outcome: "confirmed",
  verdict: "partly_evidenced",
  reason: null,
  reviewed_by: "user_1",
  reviewed_at: COVERED_AT,
  ...fields,
});

describe("reviewOutcomeLine (story 5)", () => {
  it("says a confirm's Verdict", () => {
    expect(reviewOutcomeLine(review())).toBe("Confirmed: Partly evidenced");
  });

  it("says an override's Verdict and the worked-out one it replaced", () => {
    expect(
      reviewOutcomeLine(
        review({
          outcome: "overridden",
          worked_out_verdict: "not_evidenced",
          verdict: "not_applicable",
        }),
      ),
    ).toBe("Overridden to Not applicable, from Not evidenced");
  });
});
