// /api/health against a real Postgres with pgvector (compose locally, the service in CI), and against none.
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { createHealthCheck, createPool } from "../src/database.ts";
import { closedPort, silentServer } from "./ports.ts";
import { testApp, testKey } from "./helpers.ts";

const logger = createLogger(() => {});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function healthApp(target: { host?: string; port?: number }) {
  const pool = createPool(logger, target);
  cleanups.push(() => pool.end());
  const { publicPem } = await testKey();
  return testApp({ publicPem, checkHealth: createHealthCheck(pool, logger) }).app;
}

describe("GET /api/health", () => {
  it("answers 200 with the database ok and vector available", async () => {
    const app = await healthApp({});
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ status: "ok", database: "ok", vector: "available" });
    expect(res.status).toBe(200);
  });

  it("answers 503 naming the database when Postgres refuses the connection", async () => {
    const app = await healthApp({ host: "127.0.0.1", port: await closedPort() });
    const started = Date.now();
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "unavailable",
      database: "unreachable",
      vector: "unknown",
    });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("answers 503 within about 2 seconds when Postgres never answers", async () => {
    const silent = await silentServer();
    cleanups.push(silent.close);
    const app = await healthApp({ host: "127.0.0.1", port: silent.port });
    const started = Date.now();
    const res = await app.request("/api/health");
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ database: "unreachable" });
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2500);
  });

});

describe("createHealthCheck", () => {
  it("reports vector missing when Postgres doesn't offer the extension", async () => {
    const pool = { query: async () => ({ rows: [{ vector: false }] }) };
    const body = await createHealthCheck(pool, logger)();
    expect(body).toEqual({ status: "unavailable", database: "ok", vector: "missing" });
  });
});

describe("createPool", () => {
  it("lets a query run past the health check's 2 seconds", async () => {
    const pool = createPool(logger);
    cleanups.push(() => pool.end());
    const { rows } = await pool.query("select pg_sleep(2.2), 1 as done");
    expect(rows[0]).toMatchObject({ done: 1 });
  });
});
