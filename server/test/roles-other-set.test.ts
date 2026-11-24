// The roles script refuses a database that belongs to the other role set, before changing anything: run with the
// preview set on the live database (or the other way round), it would hand the live schema to the preview migration
// role and let the preview roles connect.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, type DatabaseRoleNames } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { createRoles } from "../src/roles.ts";
import { createTestDatabase, runInServer, testName } from "./databases.ts";

const silent = createLogger(() => {});
const superuser = createPool(silent, { max: 1 });
afterAll(() => superuser.end());

/** What a run that takes a database over changes: the schema's owner and who may connect. */
async function ownership(database: string) {
  const onDatabase = createPool(silent, { database, max: 1 });
  try {
    const { rows } = await onDatabase.query<{ schemaOwner: string; acl: string | null }>(
      `select (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public') as "schemaOwner",
              (select datacl::text from pg_database where datname = current_database()) as acl`,
    );
    return rows[0];
  } finally {
    await onDatabase.end();
  }
}

/** The error a promise rejects with, or undefined. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("the roles script on a database of the other role set", () => {
  // Two sets under test names (roles belong to the whole Postgres server, so a developer's own roles are never
  // touched), each with a database of its own, made as the setup script makes them.
  const base = testName();
  const setOf = (kind: string): DatabaseRoleNames => ({
    migrate: `${base}_${kind}migrate`,
    app: `${base}_${kind}app`,
    admin: `${base}_${kind}admin`,
  });
  const live = setOf("live");
  const preview = setOf("preview");
  const sets = [live, preview];
  const databases = new Map<DatabaseRoleNames, { name: string; drop: () => Promise<unknown> }>();

  beforeAll(async () => {
    for (const names of sets) databases.set(names, await createTestDatabase({}, names));
  });
  afterAll(async () => {
    for (const database of databases.values()) await database.drop();
    for (const names of sets) {
      for (const role of [names.app, names.admin, names.migrate]) {
        await superuser.query(`drop role if exists ${role}`);
      }
    }
  });

  it.each([
    ["preview", "live", preview, live],
    ["live", "preview", live, preview],
  ])(
    "refuses the %s set on the %s set's database, naming the database and both sets, and changes nothing",
    async (_, __, running, owning) => {
      const database = databases.get(owning)!.name;
      const before = await ownership(database);
      const onDatabase = createPool(silent, { database, max: 1 });
      try {
        const error = await rejection(
          createRoles(onDatabase, { names: running, sets, logger: silent }),
        );

        expect(error).toBeInstanceOf(Error);
        const { message } = error as Error;
        expect(message).toContain(database);
        expect(message).toContain(running.migrate);
        expect(message).toContain(owning.migrate);
      } finally {
        await onDatabase.end();
      }
      expect(await ownership(database)).toEqual(before);
    },
  );
});

describe("pnpm roles for the preview set on a database the live set owns", () => {
  // The ticket's steps with the real set names, on the suite's database: the live set's, set up and migrated. A new
  // database here would slow every drop's checkpoint, which the suite's other files wait on; and the refusal comes
  // before any change, so the suite's database is left as it was.
  const database = inject("testDatabase");

  it("exits non-zero naming the database and both sets, and changes nothing", async () => {
    const before = await ownership(database);

    const { code, output } = await runInServer([process.execPath, "src/roles.ts"], {
      WARDEN_DATABASE_ROLES: "preview",
      PGDATABASE: database,
    });

    expect(code, output).not.toBe(0);
    expect(output).toContain(database);
    expect(output).toContain("warden_migrate");
    expect(output).toContain("warden_preview_migrate");
    expect(await ownership(database)).toEqual(before);
  });
});
