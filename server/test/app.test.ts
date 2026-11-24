import { beforeAll, describe, expect, it } from "vitest";
import type { CryptoKey } from "jose";
import { FRONTEND_API_HOST, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let otherKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  ({ privateKey: otherKey } = await testKey());
});

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("GET /api/me", () => {
  it("answers 200 with the user id from a valid session token", async () => {
    const { app } = testApp({ publicPem });
    const res = await app.request("/api/me", bearer(await sessionToken(key, "user_abc")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user_abc", team: null, role: null, level: null });
  });

  it.each(["bearer", "BEARER", "beaRer"])(
    "reads the auth scheme in any case: %s signs in as Bearer does",
    async (scheme) => {
      const { app } = testApp({ publicPem });
      const token = await sessionToken(key, "user_abc");
      const res = await app.request("/api/me", {
        headers: { Authorization: `${scheme} ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: "user_abc", team: null, role: null, level: null });
    },
  );

  it.each([
    ["no token", async () => ({})],
    [
      "a valid token under another scheme",
      async () => ({ headers: { Authorization: `Basic ${await sessionToken(key, "user_abc")}` } }),
    ],
    ["an expired token", async () => bearer(await sessionToken(key, "user_abc", -60))],
    ["a token signed by another key", async () => bearer(await sessionToken(otherKey, "user_abc"))],
    [
      "a header that isn't a bearer token",
      async () => ({ headers: { Authorization: "Basic abc" } }),
    ],
  ])("answers 401 with a JSON error for %s", async (_name, init) => {
    const { app } = testApp({ publicPem });
    const res = await app.request("/api/me", await init());
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });
});

describe("the sign-in limit", () => {
  const from = (address: string, init: { headers?: Record<string, string> } = {}) => ({
    ...init,
    headers: { ...init.headers, "X-Forwarded-For": address },
  });

  it("answers an address's 21st failed sign-in in a minute 429 with Retry-After, before checking the token", async () => {
    const { app } = testApp({ publicPem });
    const bad = bearer(await sessionToken(otherKey, "user_abc"));
    for (let failure = 1; failure <= 20; failure++) {
      expect((await app.request("/api/me", from("203.0.113.7", bad))).status).toBe(401);
    }

    const held = await app.request("/api/me", from("203.0.113.7", bad));
    expect(held.status).toBe(429);
    expect(await held.json()).toEqual({ error: "Too many sign-in attempts" });
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    // Before the token is checked: a good one from that address is held back too.
    const good = bearer(await sessionToken(key, "user_abc"));
    expect((await app.request("/api/me", from("203.0.113.7", good))).status).toBe(429);

    expect((await app.request("/api/me", from("198.51.100.2", bad))).status).toBe(401);
    expect((await app.request("/api/me", from("198.51.100.2", good))).status).toBe(200);
  });

  it("lets only 20 of many bad tokens sent at once be checked", async () => {
    const { app } = testApp({ publicPem });
    const bad = bearer(await sessionToken(otherKey, "user_abc"));

    const statuses = await Promise.all(
      Array.from({ length: 30 }, () => app.request("/api/me", from("203.0.113.7", bad))),
    );

    expect(statuses.filter((res) => res.status === 401)).toHaveLength(20);
    expect(statuses.filter((res) => res.status === 429)).toHaveLength(10);
  });

  it("doesn't count successful sign-ins, or hold back the health check", async () => {
    const { app } = testApp({ publicPem });
    const good = bearer(await sessionToken(key, "user_abc"));
    for (let request = 0; request < 25; request++) {
      expect((await app.request("/api/me", from("203.0.113.7", good))).status).toBe(200);
    }

    const bad = bearer(await sessionToken(otherKey, "user_abc"));
    for (let failure = 0; failure < 21; failure++) {
      await app.request("/api/me", from("203.0.113.8", bad));
    }
    expect((await app.request("/api/health", from("203.0.113.8"))).status).toBe(200);
  });
});

describe("security headers", () => {
  it.each([
    ["a dashboard file", "/assets/app.js", {}, 200],
    ["the dashboard page", "/", {}, 200],
    ["a dashboard route", "/findings", {}, 200],
    ["/api/health", "/api/health", {}, 200],
    ["a 401", "/api/me", {}, 401],
    ["a 404", "/api/nothing-here", {}, 404],
  ])("are on %s", async (_name, path, init, status) => {
    const { app } = testApp({ publicPem });
    const res = await app.request(path, init);
    expect(res.status).toBe(status);
    expectSecurityHeaders(res);
  });

  it("are on a 500", async () => {
    const { app } = testApp({ publicPem, checkHealth: () => Promise.reject(new Error("bug")) });
    const res = await app.request("/api/health");
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });

  it("allow Clerk's documented hosts and nothing else outside 'self'", async () => {
    const { app } = testApp({ publicPem });
    const csp = (await app.request("/")).headers.get("content-security-policy") ?? "";
    const hosts = [...csp.matchAll(/https:\/\/[^\s;]+/g)].map((m) => m[0]).sort();
    expect([...new Set(hosts)]).toEqual(
      [
        `https://${FRONTEND_API_HOST}`,
        "https://*.protect.clerk.com",
        "https://*.protect.clerk.com:*",
        "https://challenges.cloudflare.com",
        "https://img.clerk.com",
      ].sort(),
    );
    expect(csp).toMatch(/default-src 'self'/);
  });
});

describe("the dashboard's files", () => {
  it.each([
    ["a missing asset", "/assets/missing.js"],
    ["a missing file with an extension", "/favicon.ico"],
  ])("answer 404 for %s, not the dashboard page", async (_name, path) => {
    const { app } = testApp({ publicPem });
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<title>Warden</title>");
  });

  it("answer the dashboard page for a route without an extension", async () => {
    const { app } = testApp({ publicPem });
    const res = await app.request("/findings/F-103");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Warden</title>");
  });
});

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("an unhandled error", () => {
  it("answers 500 with a generic body holding no message or stack, and is logged", async () => {
    const { app, lines } = testApp({
      publicPem,
      checkHealth: () => Promise.reject(new Error("exploded")),
    });

    const res = await app.request("/api/health");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
    expect(body).not.toContain("exploded");
    expect(body).not.toMatch(/\bat\b.*\.ts/);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        message: "unhandled error",
        error: expect.objectContaining({ message: "exploded" }),
      }),
    );
  });
});

describe("request logs", () => {
  it("hold neither the token header nor a query string value", async () => {
    const { app, lines } = testApp({ publicPem });
    const token = await sessionToken(key, "user_abc");

    await app.request("/api/me?token=query-secret-value&page=2", {
      headers: { Authorization: `Bearer ${token}`, Cookie: "__session=cookie-secret-value" },
    });

    const logged = lines.join("");
    expect(logged).toContain("/api/me");
    for (const secret of [token, "query-secret-value", "cookie-secret-value"]) {
      expect(logged).not.toContain(secret);
    }
  });

  // Row A5: on a refused sign-in only, the line names the address the limit counted, so the first live deploy can
  // compare it with Cloud Run's httpRequest.remoteIp. Behind Cloud Run (as testApp is), that's the last entry.
  const forwarded = (init: { headers?: Record<string, string> } = {}) => ({
    ...init,
    headers: { ...init.headers, "X-Forwarded-For": "203.0.113.7, 198.51.100.9" },
  });
  const requestLines = (lines: string[]) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.message === "request");

  it("name the counted address on a 401 and a 429 from the sign-in check", async () => {
    const { app, lines } = testApp({ publicPem });
    const bad = forwarded(bearer("not-a-token"));
    for (let failure = 1; failure <= 21; failure++) await app.request("/api/me", bad);

    const logged = requestLines(lines);
    expect(logged.map((line) => line.status)).toEqual([...Array<number>(20).fill(401), 429]);
    for (const line of logged) expect(line.clientAddress).toBe("198.51.100.9");
  });

  it.each([
    ["a 200 from /api/me", "/api/me", 200],
    ["a 404 from an unknown /api path", "/api/nothing-here", 404],
    ["a 403 after a good sign-in", "/api/team/members", 403],
  ])("hold no address on %s", async (_name, path, status) => {
    const { app, lines } = testApp({ publicPem });
    const res = await app.request(path, forwarded(bearer(await sessionToken(key, "user_abc"))));
    expect(res.status).toBe(status);

    const [line, ...rest] = requestLines(lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ status });
    expect(line).not.toHaveProperty("clientAddress");
    expect(lines.join("")).not.toContain("198.51.100.9");
  });
});
