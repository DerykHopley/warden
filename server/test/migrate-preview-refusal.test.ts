// `pnpm migrate` for the preview set, on a real database, refuses the live set's migration role (#32's criterion 6;
// src/migrate.test.ts checks the same refusal against a fake pool).
import { expect, it } from "vitest";
import { createTestDatabase, poolAs, runInServer } from "./databases.ts";

it("refuses warden_migrate for the preview set, naming warden_preview_migrate, and applies nothing", async () => {
  // Not migrated, so a run that got past the refusal would leave Kysely's table behind.
  const database = await createTestDatabase();
  const pool = poolAs("warden_migrate", database.name);
  try {
    const { code, output } = await runInServer([process.execPath, "src/migrate.ts"], {
      WARDEN_DATABASE_ROLES: "preview",
      PGUSER: "warden_migrate",
      PGDATABASE: database.name,
    });

    expect(code, output).toBe(1);
    expect(output).toContain(
      "migrations run as warden_preview_migrate, not warden_migrate: set PGUSER=warden_preview_migrate",
    );
    const { rows } = await pool.query(
      "select to_regclass('kysely_migration') is not null as tracked",
    );
    expect(rows[0]).toEqual({ tracked: false });
  } finally {
    await pool.end();
    await database.drop();
  }
}, 30_000);
