// GitHub's links and the PKCE sign-in attempt, below the pages: the challenge is RFC 7636's S256, a verifier is 43
// characters, an installation id is a positive whole number, and a kept attempt is read once.
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_KEY,
  challengeOf,
  installationIdFrom,
  installUrl,
  randomToken,
  startSignIn,
  takeAttempt,
  tooManyTries,
} from "../src/github-setup.ts";

afterEach(() => sessionStorage.clear());

describe("challengeOf", () => {
  it("answers RFC 7636's own example: the verifier's SHA-256, base64url", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("randomToken", () => {
  it("is 43 base64url characters, fresh each time", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

describe("installationIdFrom", () => {
  it.each([
    ["42", 42],
    ["1", 1],
    [null, undefined],
    ["", undefined],
    ["abc", undefined],
    ["0", undefined],
    ["-3", undefined],
    ["4.2", undefined],
    ["042", undefined],
    ["99999999999999999999", undefined],
  ])("reads %j as %j", (value, id) => {
    expect(installationIdFrom(value)).toBe(id);
  });
});

it("builds the install link from the slug", () => {
  expect(installUrl("warden-reader")).toBe(
    "https://github.com/apps/warden-reader/installations/new",
  );
});

describe("startSignIn and takeAttempt", () => {
  it("keeps the attempt and answers GitHub's sign-in URL with its state, S256 challenge and this origin's callback", async () => {
    const url = new URL(await startSignIn("Iv23li-client", 42));

    const kept = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY)!) as Record<string, unknown>;
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv23li-client",
      state: kept.state,
      code_challenge: await challengeOf(kept.verifier as string),
      code_challenge_method: "S256",
      redirect_uri: `${window.location.origin}/setup/github/callback`,
    });
    expect(kept.installationId).toBe(42);
  });

  it("answers the kept attempt once, then none", async () => {
    await startSignIn("Iv23li-client", 42);

    expect(takeAttempt()).toMatchObject({ installationId: 42 });
    expect(takeAttempt()).toBeUndefined();
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  });

  it("answers none for a kept value that isn't an attempt", () => {
    sessionStorage.setItem(ATTEMPT_KEY, "not json");
    expect(takeAttempt()).toBeUndefined();
  });
});

it.each([
  [120, "Too many tries: try again in 2 min"],
  [61, "Too many tries: try again in 2 min"],
  [null, "Too many tries: try again later"],
])("words a 429 with Retry-After %j as %j", (retryAfter, words) => {
  expect(tooManyTries(retryAfter)).toBe(words);
});
