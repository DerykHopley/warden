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
        const run = createRoles(onDatabase, { names: running, sets, logger: silent });

        await expect(run).rejects.toThrow(database);
        await expect(run).rejects.toThrow(running.migrate);
        await expect(run).rejects.toThrow(owning.migrate);
      } finally {
        await onDatabase.end();
      }
      expect(await ownership(database)).toEqual(before);
    },
  );
});

describe("pnpm roles for the preview set on a database the live set owns", () => {
  // The wiring only: the script passes the real sets, so the preview set is refused on the suite's database (the live
  // set's). The tests above prove the check itself.
  const database = inject("testDatabase");

  it("exits non-zero naming warden_preview_migrate", async () => {
    // A safety net, not part of the proof: the suite's database is shared, so a run that got through would take it
    // over under every other file. This says so here, rather than as their failures.
    const before = await ownership(database);

    const { code, output } = await runInServer([process.execPath, "src/roles.ts"], {
      WARDEN_DATABASE_ROLES: "preview",
      PGDATABASE: database,
    });

    expect(code, output).not.toBe(0);
    // "roles ready" lists warden_preview_migrate too: the refusal's own wording.
    expect(output).toContain("not warden_preview_migrate");
    expect(await ownership(database)).toEqual(before);
  });
});
