// The real server process: its configuration check at start-up, staying up when the database is gone, and
// shutting down cleanly.
import { describe, expect, it } from "vitest";
import { testPublishableKey } from "./helpers.ts";
import { closedPort } from "./ports.ts";
import { startServer as start, waitForListening } from "./server-process.ts";

/** A server whose database refuses connections, listening on a spare port. */
async function startWithoutDatabase() {
  const port = await closedPort();
  const server = start({
    CLERK_SECRET_KEY: "clerk-secret-value",
    VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
    PGHOST: "127.0.0.1",
    PGPORT: String(await closedPort()),
    PGUSER: "warden",
    PGDATABASE: "warden",
    PORT: String(port),
  });
  await waitForListening(server.output);
  return { ...server, port };
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

  it("exits 0 on SIGTERM", async () => {
    const server = await startWithoutDatabase();

    server.child.kill("SIGTERM");

    expect(await server.exited).toBe(0);
  });
});
