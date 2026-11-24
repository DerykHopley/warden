// The server's database role. checkDatabaseRole, with a pool per role, refuses a role that can get around row-level
// security: a superuser, a role with BYPASSRLS, the owner of a table, of the schema or of the database, the
// migration or admin role of either set, a member of any role, or one that can become any of them. Then the real
// process: refusing warden_admin, serving as warden_app, a database that answers only after the server started, and
// a login the database refuses.
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type pg from "pg";
import { checkDatabaseRole, createPool, guardDatabaseRole } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { createTestDatabase, DATABASE_TIMEOUT_MS, testName } from "./databases.ts";
import { testPublishableKey } from "./helpers.ts";
import { closedPort, gatedProxy } from "./ports.ts";
import { logEntries, startServer, waitForListening } from "./server-process.ts";

const database = inject("testDatabase");
const silent = createLogger(() => {});
const superuserName = process.env.PGUSER ?? "warden";
const superuser = createPool(silent, { max: 1 });

// Test roles, and a database of their own (no migrations) whose database, schema and one table each have one of
// them as owner.
const base = testName();
const plainDatabase = base;
const migrateMember = `${base}_migratemember`;
const adminMember = `${base}_adminmember`;
const databaseOwner = `${base}_databaseowner`;
const schemaOwner = `${base}_schemaowner`;
const tableOwner = `${base}_tableowner`;
const testRoles = [migrateMember, adminMember, databaseOwner, schemaOwner, tableOwner];

beforeAll(async () => {
  await superuser.query(`create role ${migrateMember} login in role warden_migrate`);
  await superuser.query(`create role ${adminMember} login in role warden_admin`);
  for (const role of [databaseOwner, schemaOwner, tableOwner]) {
    await superuser.query(`create role ${role} login`);
  }
  await superuser.query(`create database ${plainDatabase} owner ${databaseOwner}`);
  const onPlain = createPool(silent, { database: plainDatabase, max: 1 });
  try {
    await onPlain.query(`alter schema public owner to ${schemaOwner}`);
    await onPlain.query(`create table public.owned (id int)`);
    await onPlain.query(`alter table public.owned owner to ${tableOwner}`);
  } finally {
    await onPlain.end();
  }
}, DATABASE_TIMEOUT_MS);
afterAll(async () => {
  await superuser.query(`drop database if exists ${plainDatabase} with (force)`);
  for (const role of testRoles) await superuser.query(`drop role if exists ${role}`);
  await superuser.end();
}, DATABASE_TIMEOUT_MS);

/** checkDatabaseRole on a connection as `role` to `on`. */
async function check(role: string, on = database) {
  const pool = createPool(silent, { user: role, database: on, max: 1 });
  try {
    return await checkDatabaseRole(pool);
  } finally {
    await pool.end();
  }
}

describe("checkDatabaseRole", () => {
  it.each([
    [superuserName, database, `${superuserName} is a superuser`],
    ["warden_admin", database, "warden_admin has BYPASSRLS"],
    [
      migrateMember,
      database,
      `${migrateMember} can become warden_migrate, which owns a table in public`,
    ],
    [adminMember, database, `${adminMember} can become warden_admin, which has BYPASSRLS`],
    [tableOwner, plainDatabase, `${tableOwner} owns a table in public`],
    [schemaOwner, plainDatabase, `${schemaOwner} owns the schema public`],
    [databaseOwner, plainDatabase, `${databaseOwner} owns the database`],
    ["warden_migrate", plainDatabase, "warden_migrate is the migration role"],
  ])("refuses %s", async (role, on, reason) => {
    expect(await check(role, on)).toEqual({ role, reason });
  });

  it(
    "refuses warden_migrate on a database with no tables yet",
    { timeout: DATABASE_TIMEOUT_MS },
    async () => {
      const fresh = await createTestDatabase();
      try {
        expect(await check("warden_migrate", fresh.name)).toMatchObject({ role: "warden_migrate" });
      } finally {
        await fresh.drop();
      }
    },
  );

  it("passes warden_app", async () => {
    expect(await check("warden_app")).toBeUndefined();
  });
});

// As on Cloud SQL, where the admin role is made without BYPASSRLS: refused by its name. Under test names, as the
// suite's warden_admin has BYPASSRLS and roles belong to the whole Postgres server. On the plain database: the suite's
// own refuses a login by any role outside the live set.
describe("checkDatabaseRole, with an admin role that has no BYPASSRLS", () => {
  const names = { migrate: "warden_migrate", admin: `${base}_admin` };
  const admin = names.admin;
  const member = `${base}_admin_member`;
  beforeAll(async () => {
    await superuser.query(`create role ${admin} login nobypassrls`);
    await superuser.query(`create role ${member} login in role ${admin}`);
  });
  afterAll(async () => {
    for (const role of [member, admin]) await superuser.query(`drop role if exists ${role}`);
  });

  async function checkNamed(role: string) {
    const pool = createPool(silent, { user: role, database: plainDatabase, max: 1 });
    try {
      return await checkDatabaseRole(pool, { names: [names] });
    } finally {
      await pool.end();
    }
  }

  it("refuses the admin role by name", async () => {
    expect(await checkNamed(admin)).toEqual({ role: admin, reason: `${admin} is the admin role` });
  });

  it("refuses a role that can become the admin role, naming it", async () => {
    expect(await checkNamed(member)).toEqual({
      role: member,
      reason: `${member} can become ${admin}, which is the admin role`,
    });
  });
});

// Two sets given, as the default gives the live and the preview set (database.test.ts): the second set's migration
// and admin roles are refused by name too, each owning nothing and without BYPASSRLS, as on Cloud SQL. Under test
// names, so a developer's own warden_preview_* roles on the same server are never touched. On the plain database:
// the suite's own refuses a login by any role outside the live set.
describe("checkDatabaseRole, given a second set's migration and admin roles", () => {
  const second = { migrate: `${base}_secondmigrate`, admin: `${base}_secondadmin` };
  beforeAll(async () => {
    for (const role of Object.values(second)) {
      await superuser.query(`create role ${role} login nobypassrls`);
    }
  });
  afterAll(async () => {
    for (const role of Object.values(second)) await superuser.query(`drop role if exists ${role}`);
  });

  it.each([
    [second.migrate, `${second.migrate} is the migration role`],
    [second.admin, `${second.admin} is the admin role`],
  ])("refuses %s by name", async (role, reason) => {
    const pool = createPool(silent, { user: role, database: plainDatabase, max: 1 });
    try {
      const names = [{ migrate: "warden_migrate", admin: "warden_admin" }, second];
      expect(await checkDatabaseRole(pool, { names })).toEqual({ role, reason });
    } finally {
      await pool.end();
    }
  });
});

// An app role is a member of no role (createRoles revokes them all): a policy for a role it's a member of would apply
// to it, so any membership at all is refused, even of a role that owns nothing and can't get around row-level
// security.
describe("checkDatabaseRole, with a role that is a member of another", () => {
  const group = `${base}_plaingroup`;
  const grouped = `${base}_grouped`;
  const noInherit = `${base}_noinherit`;
  beforeAll(async () => {
    await superuser.query(`create role ${group} nologin`);
    await superuser.query(`create role ${grouped} login in role ${group}`);
    await superuser.query(`create role ${noInherit} login`);
    await superuser.query(`grant ${group} to ${noInherit} with inherit false, set false`);
  });
  afterAll(async () => {
    for (const role of [grouped, noInherit, group]) {
      await superuser.query(`drop role if exists ${role}`);
    }
  });

  it.each([
    [grouped, `${grouped} is a member of ${group}`],
    [noInherit, `${noInherit} is a member of ${group}`],
  ])("refuses %s", async (role, reason) => {
    expect(await check(role, plainDatabase)).toEqual({ role, reason });
  });
});

describe("guardDatabaseRole", () => {
  it("throws when the check doesn't answer in time, so the connection is closed", async () => {
    const refuse = vi.fn();
    const hanging = { query: () => new Promise(() => {}) } as unknown as pg.ClientBase;

    await expect(guardDatabaseRole(refuse, { timeoutMs: 50 })(hanging)).rejects.toThrow(
      /database role check failed: .*in time/,
    );
    expect(refuse).not.toHaveBeenCalled();
  });
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
function stopLine(output: string) {
  return logEntries(output).find((entry) => entry.severity === "ERROR");
}

describe("the server process", () => {
  it("exits 1 as warden_admin, naming the role and the reason", async () => {
    const server = await serverAs("warden_admin");

    expect(await server.exited).toBe(1);
    expect(stopLine(server.output())).toMatchObject({
      role: "warden_admin",
      reason: "warden_admin has BYPASSRLS",
    });
  });

  it("starts and serves /api/health as warden_app", async () => {
    const server = await serverAs("warden_app");
    await waitForListening(server.output);

    const res = await server.health();

    expect(res.status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });

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
      expect(stopLine(server.output())).toMatchObject({ role: "warden_admin" });
    } finally {
      await late.close();
    }
  });

  it("exits 1 when the database refuses its login, saying so", async () => {
    const unknown = `${base}_nobody`;
    const server = await serverAs(unknown);

    expect(await server.exited).toBe(1);
    expect(stopLine(server.output())).toMatchObject({
      message: expect.stringMatching(/database refused the login/),
      user: unknown,
    });
    expect(server.output()).not.toMatch(/unreachable/);
  });
});
