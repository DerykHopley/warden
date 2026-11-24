// Warden's three database roles (ADR 0006), made on the database it connects to, and safe to run again: `pnpm roles`
// with the PG* variables naming the user and the database. That user is a superuser locally and in CI, and Cloud
// SQL's `postgres` there: not a superuser, but with CREATEROLE, and the database's owner.
//
// - warden_migrate owns the schema and every table, and runs the migrations.
// - warden_app is what request and job code connects as: bound by row-level security, owns nothing, and is a member
//   of no other role, so it can't `set role` its way out.
// - warden_admin bypasses row-level security, for the few deliberate cross-Team tasks. Only a user that has
//   BYPASSRLS can grant it, so on Cloud SQL warden_admin is made without it, with a warning.
//
// Only those three (and the database's owner) may connect to the database: PUBLIC loses CONNECT on it.
//
// WARDEN_DATABASE_ROLES picks the set (see databaseRoleNames): the live one above by default, or `preview` for the
// warden_preview database, whose warden_preview_* roles do the same three jobs. The setup script runs it once per
// set, each on its own database, so neither set can connect to the other's.
//
// Passwords: WARDEN_APP_PASSWORD and WARDEN_MIGRATE_PASSWORD, when set (printable ASCII), become warden_app's and
// warden_migrate's, sent as SCRAM-SHA-256 verifiers made here. Unset, no password is set, and one already set is left:
// compose and CI use trust auth. No password reaches Postgres, a log line or an error.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import {
  createPool,
  DATABASE_ROLE_NAMES,
  databaseRoleNames,
  type DatabaseRoleNames,
} from "./database.ts";
import { createLogger, type Logger } from "./log.ts";

export type CreateRolesOptions = {
  /** The roles' names; tests use their own, as roles belong to the whole Postgres server. */
  names?: DatabaseRoleNames;
  passwords?: { app?: string; migrate?: string };
  logger?: Logger;
};

/** What createRoles runs its statements through: a pool, or one connection. */
type RolesConnection = Pick<pg.Pool, "query">;

/** The attributes Warden's roles have, as pg_roles names them, with the keywords that set them. */
const ATTRIBUTES = {
  rolcanlogin: ["login", "nologin"],
  rolsuper: ["superuser", "nosuperuser"],
  rolcreatedb: ["createdb", "nocreatedb"],
  rolcreaterole: ["createrole", "nocreaterole"],
  rolbypassrls: ["bypassrls", "nobypassrls"],
} as const;

type Attribute = keyof typeof ATTRIBUTES;
type Attributes = Partial<Record<Attribute, boolean>>;

export async function createRoles(
  pool: RolesConnection,
  { names = DATABASE_ROLE_NAMES, passwords = {}, logger = createLogger() }: CreateRolesOptions = {},
): Promise<void> {
  checkPassword(names.app, passwords.app);
  checkPassword(names.migrate, passwords.migrate);
  const {
    rows: [runner],
  } = await pool.query<{
    name: string;
    superuser: boolean;
    bypassrls: boolean;
    adminBypassrls: boolean;
  }>(
    `select current_user as name, rolsuper as superuser, rolbypassrls as bypassrls,
            coalesce((select rolbypassrls from pg_roles where rolname = $1), false) as "adminBypassrls"
       from pg_roles where rolname = current_user`,
    [names.admin],
  );
  if (!runner) throw new Error("the user running roles isn't in pg_roles");
  // Postgres lets only a superuser, or a role that has BYPASSRLS itself, give BYPASSRLS or take it away.
  const canGrantBypass = runner.superuser || runner.bypassrls;
  // Warned only when warden_admin will end without it: one that already has it keeps it.
  if (!canGrantBypass && !runner.adminBypassrls) {
    logger.warn(`${names.admin} gets no BYPASSRLS: ${runner.name} can't grant it`, {
      role: names.admin,
      user: runner.name,
    });
  }

  const plain: Attributes = {
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolbypassrls: false,
  };
  await ensureRole(pool, names.migrate, plain);
  await ensureRole(pool, names.app, plain);
  // Without the right to grant it, warden_admin's BYPASSRLS is left as it is: none when it's new.
  const adminAttributes: Attributes = { ...plain, rolbypassrls: true };
  if (!canGrantBypass) delete adminAttributes.rolbypassrls;
  await ensureRole(pool, names.admin, adminAttributes);

  const [migrate, app, admin] = [names.migrate, names.app, names.admin].map(pg.escapeIdentifier);
  // warden_app may not become any other role, however it got a membership.
  await revokeMemberships(pool, names.app);

  // A user that isn't a superuser hands the schema over only when it can `set role` to the new owner, and grants on
  // the schema afterwards only with the owner's privileges: it gives itself both, through membership.
  if (!runner.superuser) {
    await pool.query(`grant ${migrate} to current_user with inherit true, set true`);
  }
  await pool.query(`alter schema public owner to ${migrate}`);
  await pool.query(`grant usage on schema public to ${app}, ${admin}`);

  await restrictConnect(pool, [names.migrate, names.app, names.admin]);

  await setPassword(pool, names.app, passwords.app);
  await setPassword(pool, names.migrate, passwords.migrate);
}

/** Only `roles` (and the database's owner) may connect to the database the roles script runs on: PUBLIC loses
 * Postgres's default CONNECT, so a role of the other set can't connect to it. A user that may not revoke it (it isn't
 * the owner, or a member of the owning role, as Cloud SQL's `postgres` is) only gets a warning from Postgres: checked
 * after, and thrown naming the database. */
async function restrictConnect(pool: RolesConnection, roles: string[]) {
  const {
    rows: [current],
  } = await pool.query<{ database: string }>("select current_database() as database");
  if (!current) throw new Error("the database running roles has no name");
  const database = pg.escapeIdentifier(current.database);
  await pool.query(`revoke connect on database ${database} from public`);
  await pool.query(
    `grant connect on database ${database} to ${roles.map(pg.escapeIdentifier).join(", ")}`,
  );
  const { rows } = await pool.query<{ open: boolean }>(
    "select has_database_privilege('public', current_database(), 'CONNECT') as open",
  );
  if (rows[0]?.open) {
    throw new Error(
      `PUBLIC can still connect to ${current.database}; revoke it as the database's owner`,
    );
  }
}

// A role is created or altered only when it differs from what's wanted, and only in the attributes that differ: roles
// belong to the whole server, and two runs altering the same role at once (the test databases are made in parallel)
// fail with "tuple concurrently updated". Restating an attribute isn't free either: Postgres refuses even
// `nosuperuser` from a user that isn't a superuser.
async function ensureRole(pool: RolesConnection, name: string, wanted: Attributes) {
  const { rows } = await pool.query<Record<Attribute, boolean>>(
    `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = $1`,
    [name],
  );
  const existing = rows[0];
  const role = pg.escapeIdentifier(name);
  if (!existing) {
    try {
      await pool.query(`create role ${role} ${keywords(Object.entries(wanted))}`);
    } catch (error) {
      // Another run made it first: duplicate_object when it had committed, unique_violation when it was midway.
      if (!isPgError(error, "42710", "23505")) throw error;
    }
    return;
  }
  const differing = Object.entries(wanted).filter(
    ([key, value]) => existing[key as Attribute] !== value,
  );
  if (differing.length > 0) await pool.query(`alter role ${role} ${keywords(differing)}`);
}

function keywords(attributes: [string, boolean | undefined][]): string {
  return attributes.map(([key, value]) => ATTRIBUTES[key as Attribute][value ? 0 : 1]).join(" ");
}

function isPgError(error: unknown, ...codes: string[]): boolean {
  return error instanceof pg.DatabaseError && codes.includes(error.code ?? "");
}

/** Postgres's own iteration count for a SCRAM-SHA-256 verifier (`scram_iterations`' default). */
const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form Postgres stores (RFC 5802, RFC 7677). Given one in ALTER
 * ROLE, Postgres stores it as it is, so the password itself never reaches the server or its logs. The password is
 * printable ASCII, so the SASLprep that Postgres and pg apply to it changes nothing.
 */
export function scramVerifier(password: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const storedKey = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Refuses a password that isn't printable ASCII, before anything is changed. */
function checkPassword(name: string, password: string | undefined) {
  if (password && !PRINTABLE_ASCII.test(password)) {
    throw new Error(`${name}'s password must be printable ASCII`);
  }
}

/** Sets `name`'s password when one is given, as a SCRAM verifier. A failure is rethrown naming the role and
 * Postgres's code only, with no cause: Postgres can quote a statement's text back. */
async function setPassword(pool: RolesConnection, name: string, password: string | undefined) {
  if (!password) return;
  try {
    await pool.query(
      `alter role ${pg.escapeIdentifier(name)} password ${pg.escapeLiteral(scramVerifier(password))}`,
    );
  } catch (error) {
    const code = error instanceof pg.DatabaseError ? error.code : undefined;
    // eslint-disable-next-line preserve-caught-error -- the cause could quote the statement back
    throw new Error(`setting ${name}'s password failed (SQLSTATE ${code ?? "unknown"})`);
  }
}

/** Every role `role` is a member of, and who granted each membership. */
async function membershipsOf(pool: RolesConnection, role: string) {
  const { rows } = await pool.query<{ role: string; grantor: string }>(
    `select r.rolname as role, g.rolname as grantor
       from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles g on g.oid = m.grantor
      where m.member = (select oid from pg_roles where rolname = $1)
      order by r.rolname`,
    [role],
  );
  return rows;
}

/** Revokes every membership the app role holds, each as granted by its grantor (a plain revoke only takes back the
 * running user's own grant), then checks none is left: a revoke the running user may not make throws here, naming
 * the role. */
async function revokeMemberships(pool: RolesConnection, app: string) {
  let refused: unknown;
  for (const { role, grantor } of await membershipsOf(pool, app)) {
    const [granted, by] = [role, grantor].map(pg.escapeIdentifier);
    await pool
      .query(`revoke ${granted} from ${pg.escapeIdentifier(app)} granted by ${by}`)
      .catch((error: unknown) => (refused ??= error));
  }
  const left = await membershipsOf(pool, app);
  if (left.length > 0) {
    const roles = [...new Set(left.map((row) => row.role))].join(", ");
    throw new Error(`${app} is still a member of ${roles}; revoke it as a superuser`, {
      cause: refused,
    });
  }
}

async function main(logger: Logger): Promise<number> {
  let names: DatabaseRoleNames;
  try {
    names = databaseRoleNames(process.env);
  } catch (error) {
    logger.error("creating the roles failed", { error });
    return 1;
  }
  const pool = createPool(logger, { max: 1 });
  try {
    await createRoles(pool, {
      names,
      logger,
      passwords: {
        app: process.env.WARDEN_APP_PASSWORD || undefined,
        migrate: process.env.WARDEN_MIGRATE_PASSWORD || undefined,
      },
    });
    logger.info("roles ready", { roles: Object.values(names) });
    return 0;
  } catch (error) {
    logger.error("creating the roles failed", { error });
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(createLogger());
}
