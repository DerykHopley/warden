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
    expect(await res.json()).toEqual({ userId: "user_abc" });
  });

  it.each([
    ["no token", async () => ({})],
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

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("an unhandled error", () => {
  it("answers 500 with a generic body holding no message or stack, and is logged redacted", async () => {
    const secret = ["sk", "live", "LeakedFromAnError1"].join("_");
    const { app, lines } = testApp({
      publicPem,
      checkHealth: () => Promise.reject(new Error(`exploded holding ${secret}`)),
    });

    const res = await app.request("/api/health");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
    expect(body).not.toContain("exploded");
    expect(body).not.toMatch(/\bat\b.*\.ts/);
    const logged = lines.join("");
    expect(logged).toContain("exploded holding sk_live_***");
    expect(logged).toContain("app.test.ts");
    expect(logged).not.toContain(secret);
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
    expect(lines.length).toBeGreaterThan(0);
    expect(logged).toContain("/api/me?token=***&page=***");
    for (const secret of [token, "query-secret-value", "cookie-secret-value"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
