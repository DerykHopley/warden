// `pnpm migrate` for the preview set, on a real database, refuses the live set's migration role (#32's criterion 6;
// src/migrate.test.ts checks the same refusal against a fake pool). It runs on the suite's database: every migration
// there is applied, so even a run that got past the refusal would change nothing.
import { afterAll, expect, inject, it } from "vitest";
import { poolAs, runInServer } from "./databases.ts";

const database = inject("testDatabase");
const pool = poolAs("warden_migrate", database);
afterAll(() => pool.end());

const applied = async () =>
  (await pool.query<{ count: number }>("select count(*)::int as count from kysely_migration"))
    .rows[0]?.count;

it("refuses warden_migrate for the preview set, naming warden_preview_migrate, and applies nothing", async () => {
  const before = await applied();

  const { code, output } = await runInServer([process.execPath, "src/migrate.ts"], {
    WARDEN_DATABASE_ROLES: "preview",
    PGUSER: "warden_migrate",
    PGDATABASE: database,
  });

  expect(code, output).toBe(1);
  expect(output).toContain(
    "migrations run as warden_preview_migrate, not warden_migrate: set PGUSER=warden_preview_migrate",
  );
  expect(await applied()).toBe(before);
});
