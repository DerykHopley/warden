// Setup's Catalogue switch (spec #341, slice 5), sent only with a token /api/me says is in the Team Setup was opened
// in, as a Product save is. What the section shows for each answer is Setup.test.tsx's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchCatalogueInTeam } from "../src/vouch.ts";
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
