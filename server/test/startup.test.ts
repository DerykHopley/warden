// The real server process: its configuration check at start-up, staying up when the database is gone, shutting down
// cleanly, and wiring the GitHub client when its settings are given.
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type pg from "pg";
import { createWithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  newTeam,
  sessionToken,
  testKey,
  testPublishableKey,
} from "./helpers.ts";
import { closedPort } from "./ports.ts";
import { startServer as start, waitForListening } from "./server-process.ts";

/** A server on a spare port with the test Clerk settings, the `database` settings and `extra`, once it's listening. */
async function startWith(database: Record<string, string>, extra: Record<string, string> = {}) {
  const port = await closedPort();
  const server = start({
    CLERK_SECRET_KEY: "clerk-secret-value",
    VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
    ...database,
    PORT: String(port),
    ...extra,
  });
  await waitForListening(server.output);
  return { ...server, port };
}

/** A server whose database refuses connections, listening on a spare port. */
async function startWithoutDatabase() {
  return startWith({
    PGHOST: "127.0.0.1",
    PGPORT: String(await closedPort()),
    PGUSER: "warden",
    PGDATABASE: "warden",
  });
}

describe("start-up", () => {
  it("exits 1 naming a missing required variable", async () => {
    const server = start({
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      PGHOST: "127.0.0.1",
      PGUSER: "warden",
      PGDATABASE: "warden",
    });

    expect(await server.exited).toBe(1);
    const entry = JSON.parse(server.output().trim().split("\n").at(-1) ?? "");
    expect(entry).toMatchObject({ severity: "ERROR", variables: ["CLERK_SECRET_KEY"] });
  });

  it("stays up and answers 503 while the database can't be reached", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);

    expect(res.status).toBe(503);
    expect(server.child.exitCode).toBeNull();
  });

  // The modules' routes are wired in index.ts: an unwired one would answer the API's 404.
  it("mounts Guard's routes: GET /api/repos asks for a sign-in", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos`);

    expect(res.status).toBe(401);
  });

  it("mounts the hook routes: GET /api/hook asks for a sign-in", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/hook`);

    expect(res.status).toBe(401);
  });

  it("exits 0 on SIGTERM", async () => {
    const server = await startWithoutDatabase();

    server.child.kill("SIGTERM");

    expect(await server.exited).toBe(0);
  });
});

describe("start-up with or without the GitHub app's settings", () => {
  let key: CryptoKey;
  let publicPem: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ privateKey: key, publicPem } = await testKey());
    pool = poolAs("warden_app", inject("testDatabase"));
  });

  afterAll(async () => {
    await pool.end();
  });

  const GITHUB_APP = {
    GITHUB_APP_CLIENT_ID: "Iv23li-the-client-id",
    GITHUB_APP_CLIENT_SECRET: "the-client-secret-value",
    GITHUB_APP_PRIVATE_KEY: gitHubAppKey(),
  };

  /**
   * An Admin's link with an empty body, to a server on the suite's database as warden_app: the route refuses the body
   * (400) when GitHub is set up, before any call to GitHub, and answers 503 when it isn't.
   */
  async function linkStatus(env: Record<string, string>) {
    const server = await startWith(
      {
        PGHOST: process.env.PGHOST ?? "",
        PGPORT: process.env.PGPORT ?? "",
        PGUSER: "warden_app",
        PGDATABASE: inject("testDatabase"),
        ...(process.env.PGPASSWORD ? { PGPASSWORD: process.env.PGPASSWORD } : {}),
      },
      { CLERK_JWT_KEY: publicPem, ...env },
    );
    const team = await newTeam(createWithTeam(pool));
    const token = await sessionToken(key, ADMIN, 60, activeOrganization(team));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/github/installations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.status;
  }

  it("builds the GitHub client when GITHUB_APP_* are set: the link route doesn't answer 503", async () => {
    expect(await linkStatus(GITHUB_APP)).toBe(400);
  });

  it("starts without them, and the link route answers 503", async () => {
    expect(await linkStatus({})).toBe(503);
  });
});
