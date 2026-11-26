// A Team's Fix PR record can't be edited, by the app or by the table's owner (#224, slice 2's audit trail), as its
// write grants can't (write-grants-append-only.test.ts). warden_app has no update, delete or truncate grant on it, so
// Postgres refuses those first; the owner, warden_migrate, has every grant, and the append-only trigger refuses it. It
// runs on a database of its own: the owner's truncate locks the table against every other file recording PRs on the
// shared one.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixPrs } from "../src/modules/guard/fix-prs.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { ADMIN, seedPatchFinding } from "./helpers.ts";

const team = `org_fix_prs_${randomUUID()}`;
let findingId: string;
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  await withTeamAs.warden_app(team, (tx) => tx.insertInto("teams").values({ id: team }).execute());
  ({ id: findingId } = await seedPatchFinding(withTeamAs.warden_app, team, randomUUID(), {
    cve: "CVE-2026-0001",
  }));
  await createFixPrs({ withTeam: withTeamAs.warden_app }).record(team, {
    findingId,
    url: "https://github.com/example/app/pull/1",
    number: 1,
    branch: "warden/fix-1",
    openedBy: ADMIN,
  });
}, 30_000);

afterAll(() => end?.(), 30_000);

const rows = () =>
  withTeamAs.warden_app(team, (tx) => tx.selectFrom("fix_prs").selectAll().orderBy("id").execute());

const attempts = {
  update: sql`update fix_prs set url = 'https://github.com/example/app/pull/2', number = 2`,
  delete: sql`delete from fix_prs`,
  truncate: sql`truncate fix_prs`,
};

describe("fix_prs is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table fix_prs/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/fix_prs is append-only/);

      expect(await rows()).toEqual(before);
    },
  );

  it("still takes a new row from warden_app", async () => {
    await withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("fix_prs")
        .values({
          team_id: team,
          finding_id: findingId,
          url: "https://github.com/example/app/pull/2",
          number: 2,
          branch: "warden/fix-2",
          opened_by: ADMIN,
        })
        .execute(),
    );

    expect((await rows()).map((row) => row.number)).toEqual([1, 2]);
  });
});
