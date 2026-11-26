// GitHub's links and the PKCE sign-in attempt, below the pages: the challenge is RFC 7636's S256, a verifier is 43
// characters, an installation id is a positive whole number, and a kept attempt is read once.
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_KEY,
  challengeOf,
  installationIdFrom,
  installUrl,
  putBackAttempt,
  randomToken,
  READ_APP,
  startSignIn,
  takeAttempt,
  tooManyTries,
  WRITE_APP,
  WRITE_ATTEMPT_KEY,
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
    const url = new URL(await startSignIn("Iv23li-client", 42, READ_APP));

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
    await startSignIn("Iv23li-client", 42, READ_APP);

    expect(takeAttempt(READ_APP)).toMatchObject({ installationId: 42 });
    expect(takeAttempt(READ_APP)).toBeUndefined();
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  });

  it("answers none for a kept value that isn't an attempt", () => {
    sessionStorage.setItem(ATTEMPT_KEY, "not json");
    expect(takeAttempt(READ_APP)).toBeUndefined();
  });
});

describe("the write app's sign-in (#224, story 5)", () => {
  it("keeps its attempt under its own key, leaves ATTEMPT_KEY untouched, and sends this origin's write callback", async () => {
    sessionStorage.setItem(ATTEMPT_KEY, "the read app's attempt");
    const url = new URL(await startSignIn("Iv23li-writer", 42, WRITE_APP));

    expect(WRITE_ATTEMPT_KEY).not.toBe(ATTEMPT_KEY);
    const kept = JSON.parse(sessionStorage.getItem(WRITE_ATTEMPT_KEY)!) as Record<string, unknown>;
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv23li-writer",
      state: kept.state,
      code_challenge: await challengeOf(kept.verifier as string),
      code_challenge_method: "S256",
      redirect_uri: `${window.location.origin}/setup/github/write/callback`,
    });
    expect(kept.installationId).toBe(42);
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBe("the read app's attempt");
  });

  it("takes only its own app's attempt: neither app reads the other's", async () => {
    await startSignIn("Iv23li-writer", 42, WRITE_APP);

    expect(takeAttempt(READ_APP)).toBeUndefined();
    expect(takeAttempt(WRITE_APP)).toMatchObject({ installationId: 42 });

    await startSignIn("Iv23li-client", 7, READ_APP);
    expect(takeAttempt(WRITE_APP)).toBeUndefined();
    expect(takeAttempt(READ_APP)).toMatchObject({ installationId: 7 });
  });

  it("puts a taken attempt back under its own app's key", () => {
    const attempt = { state: "s", verifier: "v".repeat(43), installationId: 42 };
    putBackAttempt(attempt, WRITE_APP);

    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
    expect(takeAttempt(WRITE_APP)).toEqual(attempt);
  });
});

it.each([
  [120, "Too many tries: try again in 2 min"],
  [61, "Too many tries: try again in 2 min"],
  [null, "Too many tries: try again later"],
])("words a 429 with Retry-After %j as %j", (retryAfter, words) => {
  expect(tooManyTries(retryAfter)).toBe(words);
});
