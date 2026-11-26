// The Fix PR section's calls (#224, story 6): a Guard Finding's Fix PR read, and opening one, each read into the result
// the section shows; and the reads and the open asked only with a token /api/me says is in the Finding's Team. What the
// section shows for each is FixPrSection.test.tsx's.
import type { Finding, FixPrBody } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFixPr, openFixPr, openFixPrInTeam, readFixPrInTeam } from "../src/fix-pr.ts";
import { callsTo, fetchMock, json, serve } from "./fake-api.ts";
import { TEAM } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "3f9a1c2e-0000-4000-8000-000000000001";
const FIX_PR_PATH = `/api/guard/findings/${ID}/fix-pr`;
const getToken = async () => "session-token" as string | null;

const FIX_PR: FixPrBody = {
  url: "https://github.com/acme/shop-web/pull/12",
  number: 12,
  branch: `warden/fix-${ID}`,
  opened_by: "user_me",
  opened_at: "2026-11-24T12:30:00.000Z",
};

const GRANT = {
  installation_id: 7,
  granted_by: "user_admin",
  granted_at: "2026-11-20T09:00:00.000Z",
};

const inTeam =
  (team = TEAM) =>
  () =>
    json(200, { userId: "user_me", team, role: "member", level: "quick" });

describe("fetchFixPr", () => {
  it("reads a 200 into whether the Finding is fixable and its Fix PR", async () => {
    serve({ fixPr: () => json(200, { fixable: true, fix_pr: FIX_PR }) });
    expect(await fetchFixPr(getToken, ID)).toEqual({
      kind: "fix-pr",
      fixable: true,
      fixPr: FIX_PR,
    });
    expect(callsTo(FIX_PR_PATH)).toHaveLength(1);
  });

  it("reads a 404 as not found", async () => {
    serve({ fixPr: () => json(404, { error: "No such Finding" }) });
    expect(await fetchFixPr(getToken, ID)).toEqual({ kind: "not-found" });
  });

  it.each<[string, () => Response]>([
    ["a 403", () => json(403, { error: "no Team" })],
    ["a 409", () => json(409, { error: "not opened" })],
    ["a 500", () => json(500, { error: "boom" })],
    ["a body that doesn't parse", () => json(200, { fixable: "yes", fix_pr: null })],
    [
      "a Fix PR whose URL isn't GitHub's",
      () => json(200, { fixable: true, fix_pr: { ...FIX_PR, url: "https://evil.test/pull/12" } }),
    ],
  ])("reads %s as not answering", async (_, answer) => {
    serve({ fixPr: answer });
    expect(await fetchFixPr(getToken, ID)).toEqual({ kind: "not-answering" });
  });
});

describe("openFixPr", () => {
  it("sends a POST with no body, and reads a 201 as opened and a 200 as still open, apart", async () => {
    serve({ openFixPr: () => json(201, FIX_PR) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "opened", fixPr: FIX_PR });
    expect(callsTo(FIX_PR_PATH)).toHaveLength(1);
    const init = callsTo(FIX_PR_PATH)[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();

    serve({ openFixPr: () => json(200, FIX_PR) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "still-open", fixPr: FIX_PR });
  });

  it.each([201, 200])(
    "reads a %i whose body fails FixPrBody as not answering: a Fix PR may have been opened",
    async (status) => {
      serve({ openFixPr: () => json(status, { ...FIX_PR, number: "twelve" }) });
      expect(await openFixPr(getToken, ID)).toEqual({ kind: "maybe-opened" });
    },
  );

  it("reads a 409 as a conflict, in the server's words", async () => {
    serve({ openFixPr: () => json(409, { error: "Grant write access on Setup to open Fix PRs" }) });
    expect(await openFixPr(getToken, ID)).toEqual({
      kind: "conflict",
      error: "Grant write access on Setup to open Fix PRs",
    });
  });

  it.each([400, 403, 502, 503])("reads a %i as refused, in the server's words", async (status) => {
    serve({ openFixPr: () => json(status, { error: "No Fix PR for this Rule" }) });
    expect(await openFixPr(getToken, ID)).toEqual({
      kind: "refused",
      error: "No Fix PR for this Rule",
    });
  });

  it("reads a refusal with no words as refused with none", async () => {
    serve({ openFixPr: () => new Response(null, { status: 400 }) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "refused", error: null });
  });

  it("reads a 404 as not found", async () => {
    serve({ openFixPr: () => json(404, { error: "No such Finding" }) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "not-found" });
  });

  it("reads a 429 as too many Fix PRs, with its Retry-After", async () => {
    serve({ openFixPr: () => json(429, { error: "slow down" }, { "Retry-After": "30" }) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "too-many-fix-prs", retryAfter: 30 });
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 500", () => json(500, { error: "boom" })],
  ])("reads %s as maybe opened", async (_, answer) => {
    serve({ openFixPr: answer });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "maybe-opened" });
  });

  it("reads a 401 as the session ended", async () => {
    serve({ openFixPr: () => json(401, { error: "signed out" }) });
    expect(await openFixPr(getToken, ID)).toEqual({ kind: "session-ended" });
  });
});

describe("readFixPrInTeam", () => {
  it("on an Open, fixable Finding, asks the write grants too, with the token /api/me confirmed the Team with", async () => {
    let tokens = 0;
    const freshTokens = async () => `token-${++tokens}` as string | null;
    serve({
      me: inTeam(),
      fixPr: () => json(200, { fixable: true, fix_pr: null }),
      writeGrant: () => json(200, { installations: [GRANT] }),
    });
    expect(await readFixPrInTeam(freshTokens, TEAM, ID, "open")).toEqual({
      kind: "read",
      fixable: true,
      fixPr: null,
      granted: true,
    });
    const authorization = (path: string) =>
      callsTo(path).map(([, init]) => new Headers(init?.headers).get("Authorization"));
    expect(authorization("/api/me")).toEqual(["Bearer token-1"]);
    expect(authorization(FIX_PR_PATH)).toEqual(["Bearer token-1"]);
    expect(authorization("/api/github/write-grant")).toEqual(["Bearer token-1"]);
  });

  it("reads no installations as no grant", async () => {
    serve({
      me: inTeam(),
      fixPr: () => json(200, { fixable: true, fix_pr: null }),
      writeGrant: () => json(200, { installations: [] }),
    });
    expect(await readFixPrInTeam(getToken, TEAM, ID, "open")).toMatchObject({ granted: false });
  });

  it.each<[string, Finding["status"], boolean]>([
    ["a Finding that isn't fixable", "open", false],
    ["a fixable Finding that isn't Open", "accepted", true],
  ])("on %s, asks no write grant", async (_, status, fixable) => {
    serve({ me: inTeam(), fixPr: () => json(200, { fixable, fix_pr: FIX_PR }) });
    expect(await readFixPrInTeam(getToken, TEAM, ID, status)).toEqual({
      kind: "read",
      fixable,
      fixPr: FIX_PR,
      granted: null,
    });
    expect(callsTo("/api/github/write-grant")).toHaveLength(0);
  });

  it.each<[string, () => Response]>([
    ["a 403", () => json(403, { error: "no Team" })],
    ["a 409", () => json(409, { error: "not opened" })],
    ["a body that doesn't parse", () => json(200, { installations: "none" })],
  ])("reads the write grants' %s as not answering", async (_, answer) => {
    serve({
      me: inTeam(),
      fixPr: () => json(200, { fixable: true, fix_pr: null }),
      writeGrant: answer,
    });
    expect(await readFixPrInTeam(getToken, TEAM, ID, "open")).toEqual({ kind: "not-answering" });
  });

  it("reads the Fix PR read's 404 as not found, and asks no write grant", async () => {
    serve({ me: inTeam(), fixPr: () => json(404, { error: "No such Finding" }) });
    expect(await readFixPrInTeam(getToken, TEAM, ID, "open")).toEqual({ kind: "not-found" });
    expect(callsTo("/api/github/write-grant")).toHaveLength(0);
  });

  it("while /api/me keeps naming another Team, asks neither read and counts as not answering", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve({ me: inTeam("org_left"), fixPr: () => json(404, {}) });
      const answer = readFixPrInTeam(getToken, TEAM, ID, "open");
      await vi.runAllTimersAsync();
      expect(await answer).toEqual({ kind: "not-answering" });
      expect(callsTo(FIX_PR_PATH)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads /api/me's 429 as too many sign-in attempts, and its 409 as not answering", async () => {
    serve({ me: () => json(429, {}, { "Retry-After": "30" }) });
    expect(await readFixPrInTeam(getToken, TEAM, ID, "open")).toEqual({
      kind: "too-many-attempts",
      retryAfter: 30,
    });
    serve({ me: () => json(409, { error: "not opened" }) });
    expect(await readFixPrInTeam(getToken, TEAM, ID, "open")).toEqual({ kind: "not-answering" });
    expect(callsTo(FIX_PR_PATH)).toHaveLength(0);
  });
});

describe("openFixPrInTeam", () => {
  it("sends the POST with the token /api/me confirmed the Team with", async () => {
    let tokens = 0;
    const freshTokens = async () => `token-${++tokens}` as string | null;
    serve({ me: inTeam(), openFixPr: () => json(201, FIX_PR) });
    expect(await openFixPrInTeam(freshTokens, TEAM, ID)).toEqual({
      kind: "opened",
      fixPr: FIX_PR,
    });
    expect(callsTo(FIX_PR_PATH)).toHaveLength(1);
    const init = callsTo(FIX_PR_PATH)[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("while /api/me names another Team, sends no POST and counts as not answering", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve({ me: inTeam("org_left"), openFixPr: () => json(201, FIX_PR) });
      const answer = openFixPrInTeam(getToken, TEAM, ID);
      await vi.runAllTimersAsync();
      expect(await answer).toEqual({ kind: "not-answering" });
      expect(callsTo(FIX_PR_PATH)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back the Team check's own refusals: too many sign-ins, a Team not opened", async () => {
    serve({ me: () => json(429, {}, { "Retry-After": "30" }) });
    expect(await openFixPrInTeam(getToken, TEAM, ID)).toEqual({
      kind: "too-many-sign-ins",
      retryAfter: 30,
    });
    serve({ me: () => json(409, { error: "not opened" }) });
    expect(await openFixPrInTeam(getToken, TEAM, ID)).toEqual({ kind: "team-not-opened" });
    expect(callsTo(FIX_PR_PATH)).toHaveLength(0);
  });
});
