// The real server process refusing a database role that can bypass row-level security: a superuser, a role with
// BYPASSRLS, or one that can become warden_migrate (owner of the tables) or warden_admin. It serves as warden_app.
// Then the same check when the database answers only after the server has started.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { testName } from "./databases.ts";
import { testPublishableKey } from "./helpers.ts";
import { closedPort, gatedProxy } from "./ports.ts";
import { logEntries, startServer, waitForListening } from "./server-process.ts";

const database = inject("testDatabase");
const superuser = createPool(
  createLogger(() => {}),
  { max: 1 },
);
const base = testName();
const migrateMember = `${base}_migratemember`;
const adminMember = `${base}_adminmember`;

beforeAll(async () => {
  await superuser.query(`create role ${migrateMember} login in role warden_migrate`);
  await superuser.query(`create role ${adminMember} login in role warden_admin`);
});
afterAll(async () => {
  for (const role of [migrateMember, adminMember]) {
    await superuser.query(`drop role if exists ${role}`);
  }
  await superuser.end();
});

async function serverAs(role: string, databasePort = process.env.PGPORT ?? "") {
  const port = await closedPort();
  const server = startServer({
    CLERK_SECRET_KEY: "clerk-secret-value",
    VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
    PGHOST: process.env.PGHOST ?? "",
    PGPORT: databasePort,
    PGUSER: role,
    PGDATABASE: database,
    ...(process.env.PGPASSWORD ? { PGPASSWORD: process.env.PGPASSWORD } : {}),
    PORT: String(port),
  });
  const health = () => fetch(`http://127.0.0.1:${port}/api/health`);
  return { ...server, health };
}

/** The log line the server stops with. */
function refusal(output: string) {
  return logEntries(output).find((entry) => entry.severity === "ERROR");
}

describe("the server's database role", () => {
  it.each([
    ["warden", /superuser/],
    ["warden_admin", /BYPASSRLS/],
    [migrateMember, /can become warden_migrate, which owns a table in public/],
    [adminMember, /can become warden_admin, which has BYPASSRLS/],
  ])("exits 1 as %s, naming the role and the reason", async (role, reason) => {
    const server = await serverAs(role);

    expect(await server.exited).toBe(1);
    expect(refusal(server.output())).toMatchObject({ role, reason: expect.stringMatching(reason) });
  });

  it("starts and serves /api/health as warden_app", async () => {
    const server = await serverAs("warden_app");
    await waitForListening(server.output);

    const res = await server.health();

    expect(res.status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });
});

describe("the role check when the database answers late", () => {
  it("stays up at 503, then exits 1 for a bypassing role once the database answers", async () => {
    const late = await gatedProxy(Number(process.env.PGPORT));
    try {
      const server = await serverAs("warden_admin", String(late.port));
      await waitForListening(server.output);
      expect((await server.health()).status).toBe(503);
      expect(server.child.exitCode).toBeNull();

      late.open();
      await server.health().catch(() => undefined);

      expect(await server.exited).toBe(1);
      expect(refusal(server.output())).toMatchObject({ role: "warden_admin" });
    } finally {
      await late.close();
    }
  });

  it("stays up at 503, then serves as warden_app once the database answers", async () => {
    const late = await gatedProxy(Number(process.env.PGPORT));
    try {
      const server = await serverAs("warden_app", String(late.port));
      await waitForListening(server.output);
      expect((await server.health()).status).toBe(503);

      late.open();

      expect((await server.health()).status).toBe(200);
      expect(server.child.exitCode).toBeNull();
    } finally {
      await late.close();
    }
  });
});
