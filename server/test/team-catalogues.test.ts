// A Team's Catalogues (spec #341, slice 1b, story 10): `team_catalogues` keeps each Team to its own rows under forced
// row-level security, even for a query that forgets the Team, and its checks refuse a Catalogue Warden doesn't have
// and a blank `set_by`. As warden_app on the suite's shared database, each case with Teams of its own.
import type { CatalogueId } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTeamCatalogues, type TeamCatalogues } from "../src/modules/vouch/team-catalogues.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, newTeam } from "./helpers.ts";

const ISA = "vda-isa-2027.1";

let pool: pg.Pool;
let withTeam: WithTeam;
let teamCatalogues: TeamCatalogues;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  teamCatalogues = createTeamCatalogues({ withTeam });
});

afterAll(() => pool.end());

/** Every `team_catalogues` row `team` can see, with no `where`. */
const visible = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("team_catalogues").selectAll().execute());

/**
 * A row written straight into the table under `team`'s `withTeam`. `catalogue` may be one the type refuses, to show the
 * database refuses it too.
 */
const insert = (
  team: string,
  { catalogue, ...row }: { team_id: string; catalogue: string; set_by?: string },
) =>
  withTeam(team, (tx) =>
    tx
      .insertInto("team_catalogues")
      .values({ turned_on: true, set_by: ADMIN, ...row, catalogue: catalogue as CatalogueId })
      .execute(),
  );

describe("Teams apart (ADR 0006, story 10)", () => {
  it("answers Team B's select with no `where` only Team B's row, none of Team A's", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    await teamCatalogues.set(teamA, { catalogue: ISA, on: true, setBy: ADMIN });
    await teamCatalogues.set(teamB, { catalogue: ISA, on: false, setBy: ADMIN });

    const seen = await visible(teamB);

    expect(seen.map(({ team_id, turned_on }) => ({ team_id, turned_on }))).toEqual([
      { team_id: teamB, turned_on: false },
    ]);
    expect(await teamCatalogues.list(teamA)).toMatchObject([{ catalogue: ISA, on: true }]);
  });

  it("refuses an insert under Team B naming Team A, and Team A has no row", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);

    await expect(insert(teamB, { team_id: teamA, catalogue: ISA })).rejects.toThrow(
      /row-level security/,
    );
    expect(await visible(teamA)).toEqual([]);
  });
});

describe("the table's checks", () => {
  it.each<[string, { catalogue?: string; set_by?: string }, RegExp]>([
    ["a Catalogue Warden doesn't have", { catalogue: "iso-27001" }, /catalogue_check/],
    ["a blank set_by", { set_by: " " }, /set_by_check/],
  ])("refuses %s, and adds no row", async (_name, fields, check) => {
    const team = await newTeam(withTeam);

    await expect(insert(team, { team_id: team, catalogue: ISA, ...fields })).rejects.toThrow(check);
    expect(await visible(team)).toEqual([]);
  });
});
