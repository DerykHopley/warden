import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

// Shapes built at run time, so no secret-looking literal sits in the repo.
const clerkTest = ["sk", "test", "AbCdEf0123456789xyz"].join("_");
const clerkLive = ["sk", "live", "ZyXw9876543210abc"].join("_");
const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1c2VyXzEyMyJ9", "c2lnbmF0dXJlLXBhcnQ"].join(".");

function text(value: unknown): string {
  return JSON.stringify(redact(value));
}

describe("redact", () => {
  it.each([
    ["a Clerk test secret key", `key is ${clerkTest} here`, clerkTest],
    ["a Clerk live secret key", `key=${clerkLive}`, clerkLive],
    ["a bearer token", "Bearer abc.def-ghi_jkl", "abc.def-ghi_jkl"],
    ["a JWT", `token ${jwt} seen`, jwt],
    ["a Postgres URL's password", "postgres://warden:hunter2@db:5432/warden", "hunter2"],
    ["a postgresql URL's password", "postgresql://u:p%40ss@host/db", "p%40ss"],
    ["a query string value", "GET /api/me?token=abc123&page=2", "abc123"],
  ])("masks %s in a message", (_name, input, secret) => {
    const out = redact(input) as string;
    expect(out).not.toContain(secret);
  });

  it("keeps the query string's names and the path", () => {
    expect(redact("/api/me?token=abc123&page=2")).toBe("/api/me?token=***&page=***");
  });

  it("keeps a Postgres URL's user and host", () => {
    expect(redact("postgres://warden:hunter2@db:5432/warden")).toBe(
      "postgres://warden:***@db:5432/warden",
    );
  });

  it("drops the Authorization, Cookie and Set-Cookie headers wherever they sit", () => {
    const out = text({
      headers: {
        Authorization: "Basic dXNlcjpwYXNz",
        cookie: "session=s3cr3t",
        "Set-Cookie": "a=b",
      },
      nested: [{ authorization: "Basic xyz" }],
    });
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("a=b");
    expect(out).not.toContain("xyz");
  });

  it("masks secrets in fields of nested objects", () => {
    const out = text({ context: { url: `https://x.test/cb?code=${clerkTest}`, list: [jwt] } });
    expect(out).not.toContain(clerkTest);
    expect(out).not.toContain(jwt);
  });

  it("masks secrets in an error's message and stack", () => {
    const error = new Error(`connect failed for postgres://u:hunter2@h/db with ${clerkTest}`);
    const out = text({ error });
    expect(out).toContain("Error");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain(clerkTest);
  });

  it("keeps an error's name, message shape and stack", () => {
    const out = redact(new Error("boom")) as { name: string; message: string; stack: string };
    expect(out.name).toBe("Error");
    expect(out.message).toBe("boom");
    expect(out.stack).toContain("redact.test.ts");
  });

  it("leaves numbers, booleans and null alone", () => {
    expect(redact({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });
});
