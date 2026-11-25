// 0010_repo_assets_per_installation on data 0009_repo_assets stored (#158): every Repo Asset row is kept field for
// field, and afterwards a repo two of a Team's installations list is held under each. A database of its own, migrated
// to 0009, written as the app wrote it then, then migrated to the shipped migrations.
import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepoAssets } from "../src/modules/guard/repo-assets.ts";
import type { Database } from "../src/schema.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { ADMIN, repoRef, seedTeam } from "./helpers.ts";

const teamA = `org_upgrade_a_${randomUUID()}`;
const teamB = `org_upgrade_b_${randomUUID()}`;
const AT = new Date("2026-11-24T09:00:00Z");
const LATER = new Date("2026-11-24T10:00:00Z");

type Row = Selectable<Database["repo_assets"]>;

let withTeam: WithTeam;
let owner: pg.Pool;
let end: (() => Promise<void>) | undefined;
/** Each Team's Repo Asset rows as 0009 stored them, read before 0010 ran. */
const before: Record<string, Row[]> = {};

const repoAssetRows = (run: WithTeam, team: string) =>
  run(team, (tx) =>
    tx.selectFrom("repo_assets").selectAll().orderBy("installation_id").orderBy("ref").execute(),
  );

beforeAll(async () => {
  const { pools, withTeamAs, ...made } = await ownDatabase(["warden_app", "warden_migrate"], {
    upTo: "0009_repo_assets",
    before: async (withTeamAs) => {
      const app = withTeamAs.warden_app;
      const written = {
        [teamA]: [
          {
            installation: 101,
            repos: [
              ["api", 1, AT],
              ["web", 2, LATER],
            ],
          },
          { installation: 102, repos: [["ops", 3, AT]] },
        ],
        // Team B holds a ref Team A holds: Teams never share a row.
        [teamB]: [{ installation: 201, repos: [["api", 9, LATER]] }],
      } as const;
      for (const [team, installations] of Object.entries(written)) {
        await seedTeam(app, team, [[ADMIN, "admin"]]);
        await app(team, async (tx) => {
          for (const { installation, repos } of installations) {
            await tx
              .insertInto("github_installations")
              .values({ team_id: team, installation_id: installation, linked_by: ADMIN })
              .execute();
            await tx
              .insertInto("repo_assets")
              .values(
                repos.map(([name, githubId, listedAt]) => ({
                  team_id: team,
                  ref: repoRef(name),
                  github_id: githubId,
                  installation_id: installation,
                  listed_at: listedAt,
                })),
              )
              .execute();
          }
        });
        before[team] = await repoAssetRows(app, team);
      }
    },
  });
  end = made.end;
  withTeam = withTeamAs.warden_app;
  owner = pools.warden_migrate;
}, 30_000);

afterAll(() => end?.(), 30_000);

describe("0010_repo_assets_per_installation on a database 0009 wrote", () => {
  it("keeps every Repo Asset row as it was, field for field", async () => {
    expect(before[teamA]).toHaveLength(3);
    expect(await repoAssetRows(withTeam, teamA)).toEqual(before[teamA]);
    expect(await repoAssetRows(withTeam, teamB)).toEqual(before[teamB]);
  });

  it("keys repo_assets by Team, installation and ref, keeping the foreign key to its installation", async () => {
    const { rows } = await owner.query<{ type: string; definition: string }>(
      `select contype as type, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'repo_assets'::regclass and contype in ('p', 'f') order by contype`,
    );

    expect(rows).toEqual([
      {
        type: "f",
        definition:
          "FOREIGN KEY (team_id, installation_id) REFERENCES github_installations(team_id, installation_id) ON DELETE CASCADE",
      },
      { type: "p", definition: "PRIMARY KEY (team_id, installation_id, ref)" },
    ]);
  });

  it("leaves repo_assets with row-level security forced", async () => {
    const { rows } = await owner.query<{ forced: boolean }>(
      "select relforcerowsecurity as forced from pg_class where oid = 'repo_assets'::regclass",
    );
    expect(rows).toEqual([{ forced: true }]);
  });

  it("holds a repo under a second installation that lists it, and keeps it when that one is relinked without it", async () => {
    const repoAssets = createRepoAssets({ withTeam });
    await repoAssets.link(teamA, {
      installationId: 103,
      linkedBy: ADMIN,
      repos: [{ ref: repoRef("api"), githubId: 1 }],
    });
    await repoAssets.link(teamA, { installationId: 103, linkedBy: ADMIN, repos: [] });

    expect(await repoAssetRows(withTeam, teamA)).toEqual(before[teamA]);
  });
});
