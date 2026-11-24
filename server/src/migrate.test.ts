import { describe, expect, it } from "vitest";
import { DATABASE_ROLE_NAMES, PREVIEW_DATABASE_ROLE_NAMES } from "./database.ts";
import { failureMessage, withRoleNames } from "./migrate.ts";

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
