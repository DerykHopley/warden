// The roles script against the test Postgres: the three roles, what warden_app can't do, and running it again; then
// run as Cloud SQL runs it, by a user that isn't a superuser, with and without passwords; then who may connect, with
// a set per database; then stray memberships.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, type DatabaseRoleNames } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { createRoles } from "../src/roles.ts";
import { poolAs, runInServer, testName } from "./databases.ts";
import { closedPort } from "./ports.ts";
import { scramAuthenticates } from "./scram.ts";

const database = inject("testDatabase");
const app = poolAs("warden_app", database);
const silent = createLogger(() => {});
const superuser = createPool(silent, { max: 1 });
afterAll(() => Promise.all([app.end(), superuser.end()]));

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

  it("exits 1 for a WARDEN_DATABASE_ROLES it doesn't know, before connecting", async () => {
    const { code, output } = await runInServer(["pnpm", "--silent", "roles"], {
      WARDEN_DATABASE_ROLES: "staging",
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
    });

    expect(code).toBe(1);
    expect(output).toContain("WARDEN_DATABASE_ROLES");
    expect(output).not.toMatch(/ECONNREFUSED/);
  });
});

/**
 * Three roles under test names, and a database owned by a user like Cloud SQL's `postgres` (CREATEROLE and
 * CREATEDB, no SUPERUSER or BYPASSRLS): roles belong to the whole Postgres server, and the suite's warden_* roles are
 * in use by other files. `asRunner` connects as that user, `asSuperuser` as the PG* superuser, both to that database.
 */
async function cloudSqlLike() {
  const base = testName();
  const runner = `${base}_owner`;
  const names: DatabaseRoleNames = {
    migrate: `${base}_migrate`,
    app: `${base}_app`,
    admin: `${base}_admin`,
  };
  const extraRoles: string[] = [];
  await superuser.query(`create role ${runner} login createrole createdb`);
  await superuser.query(`create database ${base} owner ${runner}`);
  const asRunner = createPool(silent, { user: runner, database: base, max: 1 });
  const asSuperuser = createPool(silent, { database: base, max: 1 });
  const lines: string[] = [];
  return {
    base,
    names,
    asRunner,
    asSuperuser,
    lines,
    logger: createLogger((line) => lines.push(line)),
    /** A role dropped with the rest. */
    role: async (suffix: string, attributes = "login") => {
      const name = `${base}_${suffix}`;
      extraRoles.push(name);
      await superuser.query(`create role ${name} ${attributes}`);
      return name;
    },
    drop: async () => {
      await asRunner.end();
      await asSuperuser.end();
      await superuser.query(`drop database if exists ${base} with (force)`);
      // The app role first: dropping it drops the memberships other roles granted it.
      for (const role of [names.app, names.admin, names.migrate, ...extraRoles, runner]) {
        await superuser.query(`drop role if exists ${role}`);
      }
    },
  };
}

async function storedPasswords(names: DatabaseRoleNames) {
  const { rows } = await superuser.query<{ rolname: string; rolpassword: string | null }>(
    "select rolname, rolpassword from pg_authid where rolname = any($1)",
    [[names.migrate, names.app, names.admin]],
  );
  return Object.fromEntries(rows.map((row) => [row.rolname, row.rolpassword]));
}

async function membershipsOf(role: string) {
  const { rows } = await superuser.query<{ rolname: string }>(
    `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where m.member = (select oid from pg_roles where rolname = $1) order by r.rolname`,
    [role],
  );
  return rows.map((row) => row.rolname);
}

/** The error a promise rejects with, or undefined. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Everything an error carries that a log line could show. */
function everythingIn(error: unknown): string {
  const { message, stack, cause } = error as Error;
  return JSON.stringify({ message, stack, cause: String(cause), own: { ...(error as object) } });
}

describe("the roles script run twice by a user with CREATEROLE that isn't a superuser", () => {
  let fixture: Awaited<ReturnType<typeof cloudSqlLike>>;
  beforeAll(async () => {
    fixture = await cloudSqlLike();
    await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
    await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
  });
  afterAll(() => fixture.drop());

  it("hands public to the migration role", async () => {
    const { rows } = await fixture.asRunner.query(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'public'",
    );
    expect(rows).toEqual([{ owner: fixture.names.migrate }]);
  });

  it("sets no password", async () => {
    const { migrate, app, admin } = fixture.names;
    expect(await storedPasswords(fixture.names)).toEqual({
      [migrate]: null,
      [app]: null,
      [admin]: null,
    });
  });

  it("makes the admin role without BYPASSRLS, and warns naming it", async () => {
    const { rows } = await superuser.query(
      "select rolbypassrls from pg_roles where rolname = any($1)",
      [Object.values(fixture.names)],
    );
    expect(rows).toEqual([
      { rolbypassrls: false },
      { rolbypassrls: false },
      { rolbypassrls: false },
    ]);
    const warnings = fixture.lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.severity === "WARNING");
    expect(warnings[0]?.message).toContain(fixture.names.admin);
    expect(warnings[0]?.message).toContain("BYPASSRLS");
  });
});

describe("the roles script run by a user that can't grant BYPASSRLS, once the admin role has it", () => {
  let fixture: Awaited<ReturnType<typeof cloudSqlLike>>;
  beforeAll(async () => {
    fixture = await cloudSqlLike();
    await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
    await superuser.query(`alter role ${fixture.names.admin} bypassrls`);
    fixture.lines.length = 0;
    await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
  });
  afterAll(() => fixture.drop());

  it("leaves the admin role's BYPASSRLS on, and logs no warning about it", async () => {
    const { rows } = await superuser.query("select rolbypassrls from pg_roles where rolname = $1", [
      fixture.names.admin,
    ]);
    expect(rows).toEqual([{ rolbypassrls: true }]);
    expect(fixture.lines.join("\n")).not.toMatch(/gets no BYPASSRLS/);
  });
});

describe("the roles script given passwords", () => {
  // A quote and a backslash, so the password's escaped form differs from its raw one.
  const passwords = {
    app: `app'pw\\${randomBytes(8).toString("hex")}`,
    migrate: `migrate'pw\\${randomBytes(8).toString("hex")}`,
  };
  let fixture: Awaited<ReturnType<typeof cloudSqlLike>>;
  beforeAll(async () => {
    fixture = await cloudSqlLike();
    await createRoles(fixture.asRunner, {
      names: fixture.names,
      logger: fixture.logger,
      passwords,
    });
  });
  afterAll(() => fixture.drop());

  it("checks a verifier as a login would", async () => {
    // Postgres's own verifier, from a password it hashed itself: the check passes it, and fails another password.
    const own = await fixture.role("hashedbypostgres");
    await superuser.query(`alter role ${own} password 'pencil'`);
    const { rows } = await superuser.query("select rolpassword from pg_authid where rolname = $1", [
      own,
    ]);
    expect(await scramAuthenticates(rows[0].rolpassword, "pencil")).toBe(true);
    expect(await scramAuthenticates(rows[0].rolpassword, "pencils")).toBe(false);
  });

  it("stores a SCRAM-SHA-256 verifier for the app and migration roles that the password signs in with", async () => {
    const stored = await storedPasswords(fixture.names);

    expect(stored[fixture.names.admin]).toBeNull();
    for (const [role, password] of [
      [fixture.names.app, passwords.app],
      [fixture.names.migrate, passwords.migrate],
    ] as const) {
      expect(stored[role]).toMatch(/^SCRAM-SHA-256\$4096:/);
      expect(await scramAuthenticates(stored[role] ?? "", password), role).toBe(true);
      expect(await scramAuthenticates(stored[role] ?? "", `${password}x`), role).toBe(false);
    }
  });

  it("sends Postgres neither password, raw or escaped", async () => {
    const statements: string[] = [];
    const recording = {
      query: (text: string, values?: unknown[]) => {
        statements.push(text, ...(values ?? []).map(String));
        return fixture.asRunner.query(text, values);
      },
    } as unknown as pg.Pool;

    await createRoles(recording, { names: fixture.names, logger: fixture.logger, passwords });

    expect(statements.some((statement) => /alter role .* password/.test(statement))).toBe(true);
    const sent = statements.join("\n");
    for (const password of Object.values(passwords)) {
      expect(sent).not.toContain(password);
      expect(sent).not.toContain(pg.escapeLiteral(password));
    }
  });

  it("logs neither password, raw or escaped", () => {
    const logged = fixture.lines.join("\n");
    for (const password of Object.values(passwords)) {
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(pg.escapeLiteral(password));
    }
  });
});

describe("the roles script failing to set a password", () => {
  it("names the role and Postgres's code, and holds the password in neither form", async () => {
    const fixture = await cloudSqlLike();
    try {
      await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
      // CREATEROLE and the admin option on the migration role only: every step passes until it sets the app role's
      // password, which Postgres refuses it.
      const stranger = await fixture.role("stranger", "login createrole createdb");
      await superuser.query(`grant ${fixture.names.migrate} to ${stranger} with admin option`);
      const asStranger = createPool(silent, { user: stranger, database: fixture.base, max: 1 });
      const password = `pw'\\${randomBytes(8).toString("hex")}`;
      try {
        const error = await rejection(
          createRoles(asStranger, {
            names: fixture.names,
            logger: fixture.logger,
            passwords: { app: password },
          }),
        );

        expect((error as Error).message).toBe(
          `setting ${fixture.names.app}'s password failed (SQLSTATE 42501)`,
        );
        expect(everythingIn(error)).not.toContain(password);
        expect(everythingIn(error)).not.toContain(pg.escapeLiteral(password));
      } finally {
        await asStranger.end();
      }
    } finally {
      await fixture.drop();
    }
  });

  it("refuses a password that isn't printable ASCII, without echoing it", async () => {
    const fixture = await cloudSqlLike();
    try {
      const error = await rejection(
        createRoles(fixture.asRunner, {
          names: fixture.names,
          logger: fixture.logger,
          passwords: { migrate: "päss-wörd" },
        }),
      );

      expect((error as Error).message).toBe(
        `${fixture.names.migrate}'s password must be printable ASCII`,
      );
      expect(everythingIn(error)).not.toContain("päss-wörd");
    } finally {
      await fixture.drop();
    }
  });
});

/**
 * Two databases, one per role set, as Cloud SQL makes them: owned by a group role (Cloud SQL's
 * `cloudsqlsuperuser`) that the user running the roles script (its `postgres`: CREATEROLE and CREATEDB, no
 * SUPERUSER) is a member of. Each set is made on its own database, twice, keeping each database's ACL after each run.
 */
async function twoSets() {
  const base = testName();
  const group = `${base}_group`;
  const runner = `${base}_runner`;
  const setOf = (kind: string): DatabaseRoleNames => ({
    migrate: `${base}_${kind}migrate`,
    app: `${base}_${kind}app`,
    admin: `${base}_${kind}admin`,
  });
  const sets = [
    { database: testName(), names: setOf("live") },
    { database: testName(), names: setOf("preview") },
  ];
  await superuser.query(`create role ${group} nologin`);
  await superuser.query(`create role ${runner} login createrole createdb in role ${group}`);
  const acls: string[][] = [];
  for (const { database } of sets) {
    await superuser.query(`create database ${database} owner ${group}`);
  }
  for (const { database, names } of sets) {
    const asRunner = createPool(silent, { user: runner, database, max: 1 });
    const runs: string[] = [];
    try {
      for (let run = 0; run < 2; run++) {
        await createRoles(asRunner, { names, logger: silent });
        const { rows } = await superuser.query<{ acl: string }>(
          "select datacl::text as acl from pg_database where datname = $1",
          [database],
        );
        runs.push(rows[0]?.acl ?? "");
      }
    } finally {
      await asRunner.end();
    }
    acls.push(runs);
  }
  return {
    sets,
    acls,
    drop: async () => {
      for (const { database } of sets) {
        await superuser.query(`drop database if exists ${database} with (force)`);
      }
      for (const { names } of sets) {
        for (const role of [names.app, names.admin, names.migrate]) {
          await superuser.query(`drop role if exists ${role}`);
        }
      }
      for (const role of [runner, group]) await superuser.query(`drop role if exists ${role}`);
    },
  };
}

describe("the roles script and who may connect", () => {
  let fixture: Awaited<ReturnType<typeof twoSets>>;
  beforeAll(async () => {
    fixture = await twoSets();
  });
  afterAll(() => fixture?.drop());

  const canConnect = async (role: string, database: string) => {
    const { rows } = await superuser.query<{ can: boolean }>(
      "select has_database_privilege($1, $2, 'CONNECT') as can",
      [role, database],
    );
    return rows[0]?.can;
  };

  it("takes CONNECT away from PUBLIC and gives it to the set's three roles only", async () => {
    const [live, preview] = fixture.sets;
    for (const [own, other] of [
      [live, preview],
      [preview, live],
    ] as const) {
      expect(await canConnect("public", own!.database)).toBe(false);
      for (const role of Object.values(own!.names)) {
        expect(await canConnect(role, own!.database), role).toBe(true);
      }
      for (const role of Object.values(other!.names)) {
        expect(await canConnect(role, own!.database), role).toBe(false);
      }
    }
  });

  it("refuses a login by the other set's app role", async () => {
    const [live, preview] = fixture.sets;
    for (const [own, other] of [
      [live, preview],
      [preview, live],
    ] as const) {
      const pool = createPool(silent, { user: other!.names.app, database: own!.database, max: 1 });
      try {
        await expect(pool.query("select 1")).rejects.toThrow(/permission denied for database/);
      } finally {
        await pool.end();
      }
    }
  });

  it("changes nothing the second time it runs", () => {
    for (const [first, second] of fixture.acls) {
      expect(first).toMatch(/=c/);
      expect(second).toBe(first);
    }
  });

  // Run again on the live database, the set's roles never lose CONNECT, even for a moment: they get it before PUBLIC
  // loses it.
  it("grants CONNECT to the set's roles before it takes it away from PUBLIC", async () => {
    const [live] = fixture.sets;
    const statements: string[] = [];
    const onDatabase = createPool(silent, { database: live!.database, max: 1 });
    try {
      const recording = {
        query: (text: string, values?: unknown[]) => {
          statements.push(text);
          return onDatabase.query(text, values);
        },
      } as unknown as pg.Pool;
      await createRoles(recording, { names: live!.names, logger: silent });
    } finally {
      await onDatabase.end();
    }

    const grant = statements.findIndex((text) => /^grant connect/.test(text));
    const revoke = statements.findIndex((text) => /^revoke connect/.test(text));
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(grant);
  });
});

describe("the roles script and stray memberships of the app role", () => {
  it("revokes them, whoever granted them", async () => {
    const fixture = await cloudSqlLike();
    try {
      await createRoles(fixture.asSuperuser, { names: fixture.names, logger: fixture.logger });
      const { app, migrate, admin } = fixture.names;
      const granter = await fixture.role("granter");
      await superuser.query(`grant ${migrate} to ${granter} with admin option`);
      await superuser.query(`grant ${migrate}, ${admin} to ${app}`);
      await superuser.query(`set role ${granter}`);
      await superuser.query(`grant ${migrate} to ${app}`);
      await superuser.query(`reset role`);
      await superuser.query(`grant pg_read_all_data to ${app}`);

      await createRoles(fixture.asSuperuser, { names: fixture.names, logger: fixture.logger });

      expect(await membershipsOf(app)).toEqual([]);
    } finally {
      await superuser.query(`reset role`);
      await fixture.drop();
    }
  });

  it("throws naming the app role when one can't be revoked", async () => {
    const fixture = await cloudSqlLike();
    try {
      await createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger });
      // Granted by the superuser: a user that isn't one may not revoke it.
      await superuser.query(`grant pg_read_all_data to ${fixture.names.app}`);

      const error = await rejection(
        createRoles(fixture.asRunner, { names: fixture.names, logger: fixture.logger }),
      );

      expect((error as Error).message).toMatch(
        `${fixture.names.app} is still a member of pg_read_all_data`,
      );
    } finally {
      await fixture.drop();
    }
  });
});
