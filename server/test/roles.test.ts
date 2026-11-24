// The roles script against the test Postgres: the three roles, what warden_app can't do, and running it again; then
// run as Cloud SQL runs it, by a user that isn't a superuser, with and without passwords.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { createRoles, type RoleNames } from "../src/roles.ts";
import { poolAs, runInServer, testName } from "./databases.ts";

const database = inject("testDatabase");
const app = poolAs("warden_app", database);
afterAll(() => app.end());

describe("the roles script", () => {
  beforeAll(async () => {
    // Run by the PG* superuser, twice: the global setup already made the roles, so both runs find them.
    for (const run of [1, 2]) {
      const { code, output } = await runInServer([process.execPath, "src/roles.ts"], {
        PGDATABASE: database,
      });
      expect(code, `run ${run}: ${output}`).toBe(0);
    }
  });

  it("leaves warden_migrate, warden_app and warden_admin, with only warden_admin bypassing RLS", async () => {
    const { rows } = await app.query(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles
        where rolname in ('warden_migrate', 'warden_app', 'warden_admin') order by rolname`,
    );
    expect(rows).toEqual([
      { rolname: "warden_admin", rolsuper: false, rolbypassrls: true, rolcanlogin: true },
      { rolname: "warden_app", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: "warden_migrate", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    ]);
  });

  it("makes warden_app a member of no other role", async () => {
    const { rows } = await app.query(
      `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
        where m.member = (select oid from pg_roles where rolname = 'warden_app')`,
    );
    expect(rows).toEqual([]);
  });

  it.each(["warden_admin", "warden_migrate"])("refuses warden_app a set role %s", async (role) => {
    await expect(app.query(`set role ${role}`)).rejects.toThrow(/permission denied/);
  });
});

// Roles belong to the whole Postgres server, and the suite's warden_* roles are in use by other files, so this run
// makes its own three under test names, in a database of its own.
describe("the roles script run by a user with CREATEROLE that isn't a superuser and owns the database", () => {
  const silent = createLogger(() => {});
  const superuser = createPool(silent, { max: 1 });
  const base = testName();
  const runner = `${base}_owner`;
  const names: RoleNames = {
    migrate: `${base}_migrate`,
    app: `${base}_app`,
    admin: `${base}_admin`,
  };
  const passwords = {
    app: `app-pw-${randomBytes(8).toString("hex")}`,
    migrate: `migrate-pw-${randomBytes(8).toString("hex")}`,
  };
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  let asRunner: ReturnType<typeof createPool>;

  beforeAll(async () => {
    // As Cloud SQL's `postgres`: CREATEROLE and CREATEDB, no SUPERUSER or BYPASSRLS, owner of the database.
    await superuser.query(`create role ${runner} login createrole createdb`);
    await superuser.query(`create database ${base} owner ${runner}`);
    asRunner = createPool(silent, { user: runner, database: base, max: 1 });
  });

  afterAll(async () => {
    await asRunner.end();
    await superuser.query(`drop database if exists ${base} with (force)`);
    for (const role of [names.app, names.admin, names.migrate, runner]) {
      await superuser.query(`drop role if exists ${role}`);
    }
    await superuser.end();
  });

  async function passwordsSet() {
    const { rows } = await superuser.query<{ rolname: string; set: boolean }>(
      `select rolname, rolpassword is not null as set from pg_authid
        where rolname = any($1) order by rolname`,
      [[names.migrate, names.app, names.admin]],
    );
    return Object.fromEntries(rows.map((row) => [row.rolname, row.set]));
  }

  it("succeeds twice, hands public to the migration role, and sets no password", async () => {
    await createRoles(asRunner, { names, logger });
    await createRoles(asRunner, { names, logger });

    const { rows } = await asRunner.query(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'public'",
    );
    expect(rows).toEqual([{ owner: names.migrate }]);
    expect(await passwordsSet()).toEqual({
      [names.migrate]: false,
      [names.app]: false,
      [names.admin]: false,
    });
  });

  it("makes the admin role without BYPASSRLS, and warns naming it", async () => {
    const { rows } = await superuser.query(
      "select rolname, rolbypassrls from pg_roles where rolname = any($1) order by rolname",
      [[names.migrate, names.app, names.admin]],
    );
    expect(rows.every((row) => row.rolbypassrls === false)).toBe(true);
    const warnings = lines.map((line) => JSON.parse(line)).filter((e) => e.severity === "WARNING");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain(names.admin);
    expect(warnings[0].message).toContain("BYPASSRLS");
  });

  it("sets the app and migration roles' passwords when given, and logs neither", async () => {
    await createRoles(asRunner, { names, logger, passwords });

    expect(await passwordsSet()).toEqual({
      [names.migrate]: true,
      [names.app]: true,
      [names.admin]: false,
    });
    const logged = lines.join("\n");
    expect(logged).not.toContain(passwords.app);
    expect(logged).not.toContain(passwords.migrate);
  });

  it("names the role but not the password when setting it fails", async () => {
    // A user with CREATEROLE and the admin option on the migration role only: every step passes until it sets the
    // app role's password, which Postgres refuses it.
    const stranger = `${base}_stranger`;
    await superuser.query(`create role ${stranger} login createrole createdb`);
    await superuser.query(`grant ${names.migrate} to ${stranger} with admin option`);
    const asStranger = createPool(silent, { user: stranger, database: base, max: 1 });
    try {
      const error = await createRoles(asStranger, { names, logger, passwords }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        `setting ${names.app}'s password failed: permission denied`,
      );
      const seen = JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
        cause: (error as Error).cause,
        own: { ...(error as object) },
      });
      expect(seen).not.toContain(passwords.app);
      expect(seen).not.toContain(passwords.migrate);
      expect(lines.join("\n")).not.toContain(passwords.app);
    } finally {
      await asStranger.end();
      await superuser.query(`drop role if exists ${stranger}`);
    }
  });
});
