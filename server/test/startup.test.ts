// The real server process: its configuration check at start-up, staying up when the database is gone, shutting
// down cleanly, and the modules it wires in.
import { randomUUID } from "node:crypto";
import { FindingsBody } from "@warden/contracts";
import { describe, expect, inject, it } from "vitest";
import { createWithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  seedTeam,
  sessionToken,
  testKey,
  testPublishableKey,
} from "./helpers.ts";
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

  it("exits 0 on SIGTERM", async () => {
    const server = await startWithoutDatabase();

    server.child.kill("SIGTERM");

    expect(await server.exited).toBe(0);
  });
});

describe("the start-up file's wiring", () => {
  // Story 3 end to end: the start-up file gives Patch's routes the Patch Scan, so a saved Product's CVEs are Findings.
  it("answers a Lead's saved Product with its CVE Findings", async () => {
    const database = inject("testDatabase");
    const pool = poolAs("warden_app", database);
    const team = `org_${randomUUID()}`;
    try {
      await seedTeam(createWithTeam(pool), team, [["user_lead", "lead"]]);
    } finally {
      await pool.end();
    }
    const { privateKey, publicPem } = await testKey();
    const port = await closedPort();
    const server = start({
      CLERK_SECRET_KEY: "clerk-secret-value",
      CLERK_JWT_KEY: publicPem,
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      PGHOST: process.env.PGHOST ?? "",
      PGPORT: process.env.PGPORT ?? "",
      PGUSER: "warden_app",
      PGDATABASE: database,
      ...(process.env.PGPASSWORD ? { PGPASSWORD: process.env.PGPASSWORD } : {}),
      PORT: String(port),
    });
    await waitForListening(server.output);
    const token = await sessionToken(privateKey, "user_lead", 60, activeOrganization(team));
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });

    const saved = await request("/api/products", {
      method: "POST",
      body: JSON.stringify({
        name: "Chatbot",
        repo_urls: [],
        dependencies: [
          { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: false },
        ],
      }),
    });
    const { findings } = FindingsBody.parse(await (await request("/api/findings")).json());

    expect(saved.status).toBe(201);
    expect(findings.map(({ location }) => location)).toContainEqual({
      kind: "dependency",
      package: "pkg:pypi/langchain",
      version: "0.0.200",
      vulnerability: "CVE-2023-36188",
    });
  });
});
