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
// Passwords: WARDEN_APP_PASSWORD and WARDEN_MIGRATE_PASSWORD, when set, become warden_app's and warden_migrate's.
// Unset, no password is set: compose and CI use trust auth. No password reaches a log line or an error.
import pg from "pg";
import { createPool } from "./database.ts";
import { createLogger, type Logger } from "./log.ts";

export type RoleNames = { migrate: string; app: string; admin: string };

export const ROLE_NAMES: RoleNames = {
  migrate: "warden_migrate",
  app: "warden_app",
  admin: "warden_admin",
};

export type RoleOptions = {
  /** The roles' names; tests use their own, as roles belong to the whole Postgres server. */
  names?: RoleNames;
  passwords?: { app?: string; migrate?: string };
  logger?: Logger;
};

type Queryable = Pick<pg.Pool, "query">;

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
  pool: Queryable,
  { names = ROLE_NAMES, passwords = {}, logger = createLogger() }: RoleOptions = {},
): Promise<void> {
  const {
    rows: [runner],
  } = await pool.query<{ name: string; superuser: boolean; bypassrls: boolean }>(
    `select current_user as name, rolsuper as superuser, rolbypassrls as bypassrls
       from pg_roles where rolname = current_user`,
  );
  if (!runner) throw new Error("the user running roles isn't in pg_roles");
  // Postgres lets only a superuser, or a role that has BYPASSRLS itself, give BYPASSRLS or take it away.
  const canGrantBypass = runner.superuser || runner.bypassrls;
  if (!canGrantBypass) {
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
  // warden_app may not become the other two, however it got a membership.
  const { rowCount } = await pool.query(
    `select from pg_auth_members m
      where m.member = (select oid from pg_roles where rolname = $1)
        and m.roleid in (select oid from pg_roles where rolname = any($2))`,
    [names.app, [names.migrate, names.admin]],
  );
  if (rowCount) await pool.query(`revoke ${migrate}, ${admin} from ${app}`);

  // A user that isn't a superuser hands the schema over only when it can `set role` to the new owner, and grants on
  // the schema afterwards only with the owner's privileges: it gives itself both, through membership.
  if (!runner.superuser) {
    await pool.query(`grant ${migrate} to current_user with inherit true, set true`);
  }
  await pool.query(`alter schema public owner to ${migrate}`);
  await pool.query(`grant usage on schema public to ${app}, ${admin}`);

  await setPassword(pool, names.app, passwords.app);
  await setPassword(pool, names.migrate, passwords.migrate);
}

// A role is created or altered only when it differs from what's wanted, and only in the attributes that differ: roles
// belong to the whole server, and two runs altering the same role at once (the test databases are made in parallel)
// fail with "tuple concurrently updated". Restating an attribute isn't free either: Postgres refuses even
// `nosuperuser` from a user that isn't a superuser.
async function ensureRole(pool: Queryable, name: string, wanted: Attributes) {
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

/** Sets `name`'s password when one is given. A failure is rethrown as a new error naming the role, with Postgres's
 * message masked and no cause: Postgres can quote the statement's text back (a syntax error names the token), and
 * the statement holds the password. */
async function setPassword(pool: Queryable, name: string, password: string | undefined) {
  if (!password) return;
  try {
    await pool.query(
      `alter role ${pg.escapeIdentifier(name)} password ${pg.escapeLiteral(password)}`,
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.replaceAll(password, "***") : "unknown error";
    // eslint-disable-next-line preserve-caught-error -- the cause could quote the password back
    throw new Error(`setting ${name}'s password failed: ${reason}`);
  }
}

if (import.meta.main) {
  const logger = createLogger();
  const pool = createPool(logger, { max: 1 });
  try {
    await createRoles(pool, {
      logger,
      passwords: {
        app: process.env.WARDEN_APP_PASSWORD || undefined,
        migrate: process.env.WARDEN_MIGRATE_PASSWORD || undefined,
      },
    });
    logger.info("roles ready", { roles: Object.values(ROLE_NAMES) });
  } catch (error) {
    logger.error("creating the roles failed", { error });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
