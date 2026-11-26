// A Team's write-grant record can't be edited, by the app or by the table's owner (#224, story 5), as a Finding's
// history can't (finding-history.test.ts). warden_app has no update, delete or truncate grant on it, so Postgres refuses
// those first; the owner, warden_migrate, has every grant, and the append-only trigger refuses it. It runs on a
// database of its own: the owner's truncate locks the table against every other file writing grants on the shared one.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWriteGrants } from "../src/modules/guard/write-grants.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { ADMIN, newInstallation } from "./helpers.ts";

const team = `org_write_grants_${randomUUID()}`;
const installationId = newInstallation();
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  await withTeamAs.warden_app(team, (tx) => tx.insertInto("teams").values({ id: team }).execute());
  await createWriteGrants({ withTeam: withTeamAs.warden_app }).grant(team, {
    installationId,
    grantedBy: ADMIN,
  });
}, 30_000);

afterAll(() => end?.(), 30_000);

const rows = () =>
  withTeamAs.warden_app(team, (tx) =>
    tx.selectFrom("github_write_grants").selectAll().orderBy("id").execute(),
  );

const attempts = {
  update: sql`update github_write_grants set event = 'revoked', caused_by = 'user_rewritten'`,
  delete: sql`delete from github_write_grants`,
  truncate: sql`truncate github_write_grants`,
};

describe("github_write_grants is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table github_write_grants/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/github_write_grants is append-only/);

      expect(await rows()).toEqual(before);
    },
  );

  it("still takes a new row from warden_app", async () => {
    await withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("github_write_grants")
        .values({
          team_id: team,
          installation_id: installationId,
          event: "revoked",
          caused_by: "user_member",
        })
        .execute(),
    );

    expect((await rows()).map((row) => row.event)).toEqual(["granted", "revoked"]);
  });
});
