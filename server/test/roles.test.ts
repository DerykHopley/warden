// The roles script against the test Postgres: the three roles, what warden_app can't do, and running it again.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { poolAs, runInServer } from "./databases.ts";

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
