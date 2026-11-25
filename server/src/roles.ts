// Warden's three database roles (ADR 0006), made on the database it connects to, and safe to run again: `pnpm roles`
// with the PG* variables naming the user and the database. That user is a superuser locally and in CI, and Cloud
// SQL's `postgres` there: not a superuser, but with CREATEROLE, and the database's owner.
//
// - warden_migrate owns the schema and every table, and runs the migrations.
// - warden_app is what request and job code connects as: bound by row-level security, owns nothing, and is a member
//   of no other role, so it can't `set role` its way out.
// - warden_admin is the daily Job's way to list Team ids (ADR 0009): no BYPASSRLS anywhere, here as on Cloud SQL, so
//   it reads only what 0006_proposals's policy and column grant on `teams` allow. A superuser runner takes BYPASSRLS
//   away from one that has it; a runner that can't (Cloud SQL's `postgres`) warns instead, and refuses to set its
//   password.
//
// Only those three (and the database's owner) may connect to the database: PUBLIC loses CONNECT on it.
//
// WARDEN_DATABASE_ROLES picks the set (see databaseRoleNames): the live one above by default, or `preview` for the
// warden_preview database, whose warden_preview_* roles do the same three jobs. The setup script runs it once per
// set, each on its own database, so neither set can connect to the other's. Run by hand with the wrong set, it refuses
// a database that belongs to the other set before changing anything (see refuseOtherSet).
//
// Passwords: WARDEN_APP_PASSWORD, WARDEN_MIGRATE_PASSWORD and WARDEN_ADMIN_PASSWORD, when set (printable ASCII),
// become warden_app's, warden_migrate's and warden_admin's, sent as SCRAM-SHA-256 verifiers made here. Unset, no
// password is set, and one already set is left: compose and CI use trust auth. No password reaches Postgres, a log
// line or an error.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import {
  createPool,
  DATABASE_ROLE_NAMES,
  DATABASE_ROLE_SETS,
  databaseRoleNames,
  isPgError,
  type DatabaseRoleNames,
} from "./database.ts";
import { createLogger, type Logger } from "./log.ts";

export type CreateRolesOptions = {
  /** The roles' names; tests use their own, as roles belong to the whole Postgres server. */
  names?: DatabaseRoleNames;
  /** Every role set: a database that belongs to one other than `names` is refused. The live and the preview set
   * unless given; tests pass their own. */
  sets?: readonly DatabaseRoleNames[];
  passwords?: { app?: string; migrate?: string; admin?: string };
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
  {
    names = DATABASE_ROLE_NAMES,
    sets = DATABASE_ROLE_SETS,
    passwords = {},
    logger = createLogger(),
  }: CreateRolesOptions = {},
): Promise<void> {
  checkPassword(names.app, passwords.app);
  checkPassword(names.migrate, passwords.migrate);
  checkPassword(names.admin, passwords.admin);
  await refuseOtherSet(
    pool,
    names,
    sets.filter((set) => set.migrate !== names.migrate),
  );
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
  const canChangeBypass = runner.superuser || runner.bypassrls;
  // warden_admin keeps BYPASSRLS only where it has it and the runner can't take it away. A role that can read every
  // Team gets no password to log in with: refused before anything changes.
  const adminKeepsBypass = runner.adminBypassrls && !canChangeBypass;
  if (adminKeepsBypass && passwords.admin) {
    throw new Error(
      `${names.admin} has BYPASSRLS and ${runner.name} can't take it away, so its password isn't set: ` +
        "run roles as a superuser, or take BYPASSRLS away first. Nothing was changed",
    );
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
  // warden_admin has no BYPASSRLS either: one policy lets it list Team ids (0006_proposals). A runner that may not
  // take BYPASSRLS away (Cloud SQL's `postgres`) leaves it as it is: none when the role is new, as there. One that
  // has it still is warned about.
  const plainKeepingBypass: Attributes = { ...plain };
  delete plainKeepingBypass.rolbypassrls;
  await ensureRole(pool, names.admin, canChangeBypass ? plain : plainKeepingBypass);
  if (adminKeepsBypass) {
    logger.warn(
      `${names.admin} keeps BYPASSRLS: ${runner.name} can't take it away; run roles as a superuser`,
      { role: names.admin, user: runner.name },
    );
  }

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
  await setPassword(pool, names.admin, passwords.admin);
}

/** Throws, before anything is changed, when the database belongs to one of the `others` sets: that set's migration
 * role owns its schema public, or one of that set's roles may connect to it (its owner can, so a database the other
 * migration role owns counts too). Taking it over would hand the other set's tables to `names`' migration role. A
 * fresh database, or one `names` already owns, passes. */
async function refuseOtherSet(
  pool: RolesConnection,
  names: DatabaseRoleNames,
  others: readonly DatabaseRoleNames[],
) {
  const {
    rows: [found],
  } = await pool.query<{ database: string; schemaOwner: string | null; connecting: string[] }>(
    `select current_database() as database,
            (select pg_get_userbyid(nspowner)::text from pg_namespace where nspname = 'public') as "schemaOwner",
            array(select distinct pg_get_userbyid(acl.grantee)::text
                    from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
                   where d.datname = current_database() and acl.privilege_type = 'CONNECT' and acl.grantee <> 0
                   order by 1) as connecting`,
  );
  if (!found) throw new Error("the database running roles has no name");
  for (const other of others) {
    const roles = [other.migrate, other.app, other.admin];
    const signs = [
      ...(found.schemaOwner === other.migrate ? [`${other.migrate} owns its schema public`] : []),
      ...found.connecting
        .filter((role) => roles.includes(role))
        .map((role) => `${role} may connect to it`),
    ];
    if (signs.length > 0) {
      throw new Error(
        `${found.database} belongs to the role set of ${roles.join(", ")}, not ${names.migrate}, ${names.app}, ` +
          `${names.admin}: ${signs.join("; ")}. Nothing was changed: run roles for that set, or on this set's own database`,
      );
    }
  }
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
  // Granted first: run again on a database in use, the roles never lose CONNECT between the two statements.
  await pool.query(
    `grant connect on database ${database} to ${roles.map(pg.escapeIdentifier).join(", ")}`,
  );
  await pool.query(`revoke connect on database ${database} from public`);
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
        admin: process.env.WARDEN_ADMIN_PASSWORD || undefined,
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
