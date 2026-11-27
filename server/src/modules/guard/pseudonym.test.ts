// A developer's pseudonym (#183; #100's question 4): HMAC-SHA256 under the Team's key, itself derived from Warden's
// one pseudonym key with the Team id.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOf, pseudonym } from "./pseudonym.ts";

const key = randomBytes(32);

describe("pseudonym", () => {
  it("gives the same 64 lower-case hex digits for the same Team and developer", () => {
    const value = pseudonym(key, "org_a", "alice");
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(pseudonym(key, "org_a", "alice")).toBe(value);
  });

  it("gives another value for another Team, another developer or another key", () => {
    const value = pseudonym(key, "org_a", "alice");
    expect(pseudonym(key, "org_b", "alice")).not.toBe(value);
    expect(pseudonym(key, "org_a", "bob")).not.toBe(value);
    expect(pseudonym(randomBytes(32), "org_a", "alice")).not.toBe(value);
  });

  it("isn't the plain SHA-256 of the developer", () => {
    const plain = createHash("sha256").update("alice").digest("hex");
    expect(pseudonym(key, "org_a", "alice")).not.toBe(plain);
  });

  it("can't be told apart by moving characters between the Team and the developer", () => {
    expect(pseudonym(key, "org_a", "bc")).not.toBe(pseudonym(key, "org_ab", "c"));
  });
});

describe("developerOf: the developer an X-Warden-Developer header names", () => {
  it.each([
    ["no header", undefined],
    ["an empty one", ""],
    ["the literal $USER, which Claude Code left unfilled", "$USER"],
  ])("is none for %s", (_name, header) => {
    expect(developerOf(header)).toBeUndefined();
  });

  it("is the header's first 256 characters", () => {
    expect(developerOf("alice")).toBe("alice");
    expect(developerOf("a".repeat(300))).toBe("a".repeat(256));
  });
});
