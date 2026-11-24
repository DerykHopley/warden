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

  it("masks a Postgres URL's whole password when it holds an @", () => {
    expect(redact("postgres://u:p@ss@host/db")).toBe("postgres://u:***@host/db");
    expect(redact("postgres://u:a@b@c@host:5432/db?x")).toBe("postgres://u:***@host:5432/db?x");
  });

  it("masks both passwords in a string with two Postgres URLs, keeping each user and host", () => {
    expect(
      redact("from postgres://alice:p@ss@db1/a to postgresql://bob:x@y@db2:5432/b failed"),
    ).toBe("from postgres://alice:***@db1/a to postgresql://bob:***@db2:5432/b failed");
    expect(redact("postgres://alice:p@db1/a,postgres://bob:q@ss@db2/b")).toBe(
      "postgres://alice:***@db1/a,postgres://bob:***@db2/b",
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

  it("keeps a system error's code, errno, syscall, address and port, strings still masked", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: "postgres://u:hunter2@10.0.0.5/db",
      port: 5432,
      config: { password: "not-kept" },
    });
    expect(redact(error)).toMatchObject({
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: "postgres://u:***@10.0.0.5/db",
      port: 5432,
    });
    expect(text(error)).not.toContain("not-kept");
  });

  it("reads every error inside an AggregateError, masked", () => {
    const error = new AggregateError(
      [new Error(`first with ${clerkTest}`), new Error("second")],
      "all failed",
    );
    const out = redact(error) as { errors: { message: string }[] };
    expect(out.errors.map((e) => e.message)).toEqual(["first with sk_test_***", "second"]);
  });

  it("reads an object that appears twice in full, and marks only a real cycle", () => {
    const shared = { url: "/x?token=abc" };
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(redact({ a: shared, b: shared, cyclic })).toEqual({
      a: { url: "/x?token=***" },
      b: { url: "/x?token=***" },
      cyclic: { name: "loop", self: "[circular]" },
    });
  });

  it("leaves numbers, booleans and null alone", () => {
    expect(redact({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });
});
