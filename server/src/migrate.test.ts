import type pg from "pg";
import { describe, expect, it } from "vitest";
import { DATABASE_ROLE_NAMES, PREVIEW_DATABASE_ROLE_NAMES } from "./database.ts";
import { failureMessage, migrate, withRoleNames } from "./migrate.ts";

describe("withRoleNames", () => {
  it("swaps each live role name for the set's", () => {
    expect(
      withRoleNames(
        `alter default privileges for role warden_migrate in schema public
  grant select on tables to warden_app, "warden_admin";
revoke all on t from warden_app;`,
        PREVIEW_DATABASE_ROLE_NAMES,
      ),
    ).toBe(`alter default privileges for role warden_preview_migrate in schema public
  grant select on tables to warden_preview_app, "warden_preview_admin";
revoke all on t from warden_preview_app;`);
  });

  it("swaps whole words only", () => {
    const text =
      "grant x to warden_app_x, warden_preview_app, x_warden_app, warden_app2, $warden_admin, warden_migrate$1;";
    expect(withRoleNames(text, PREVIEW_DATABASE_ROLE_NAMES)).toBe(text);
  });

  it("leaves the text as it is for the live set", () => {
    const text = "grant select on tables to warden_app; -- warden_admin, warden_migrate";
    expect(withRoleNames(text, DATABASE_ROLE_NAMES)).toBe(text);
  });

  // Postgres folds an unquoted name to lower case, and keeps a double-quoted one exactly.
  it("swaps an unquoted name in any case, and a quoted one only when it's exact", () => {
    expect(
      withRoleNames(
        `REVOKE ALL ON t FROM WARDEN_APP; grant select on t to "warden_app", Warden_Admin;
grant select on t to "WARDEN_APP", "Warden_admin", "warden_app x";`,
        PREVIEW_DATABASE_ROLE_NAMES,
      ),
    )
      .toBe(`REVOKE ALL ON t FROM warden_preview_app; grant select on t to "warden_preview_app", warden_preview_admin;
grant select on t to "WARDEN_APP", "Warden_admin", "warden_app x";`);
  });
});

describe("migrate", () => {
  it("refuses a user that isn't the set's migration role, naming it, before running anything", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [{ user: "warden_migrate" }] };
      },
    } as unknown as pg.Pool;

    const result = await migrate(pool, "/no/such/folder", PREVIEW_DATABASE_ROLE_NAMES);

    expect(result.applied).toEqual([]);
    expect((result.error as Error).message).toBe(
      "migrations run as warden_preview_migrate, not warden_migrate: set PGUSER=warden_preview_migrate",
    );
    expect(queries).toHaveLength(1);
  });
});

describe("failureMessage", () => {
  it("names the failed migration", () => {
    expect(failureMessage({ applied: ["0001_good"], failed: "0002_bad", error: new Error() })).toBe(
      "migration 0002_bad failed; it was rolled back and no later migration was applied",
    );
  });

  it("says nothing ran when the run stopped before any migration", () => {
    expect(failureMessage({ applied: [], error: new Error() })).toBe(
      "migrating failed before any migration ran",
    );
  });

  it("names what was applied when the run stopped between migrations", () => {
    expect(failureMessage({ applied: ["0001_a", "0002_b"], error: new Error() })).toBe(
      "migrating stopped after applying 0001_a, 0002_b; no later migration was applied",
    );
  });
});
