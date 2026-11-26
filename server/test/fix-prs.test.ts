// A Team's Fix PRs (#224, owner answer 2, story 15): each PR Warden opened for a Finding, kept append-only in `fix_prs`
// and keyed by the Team and the Finding, stored by the Guard module's store on the suite's shared database through
// withTeam. Each case has Teams and Findings of its own, so files running at once never meet.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createFixPrs, type FixPrs } from "../src/modules/guard/fix-prs.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, newTeam, seedPatchFinding } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let fixPrs: FixPrs;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  fixPrs = createFixPrs({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

/** A new Team with one Finding of its own; the table takes any Finding, so a Patch one stands in. */
async function teamWithFinding() {
  const team = await newTeam(withTeam);
  const finding = await seedPatchFinding(withTeam, team, randomUUID(), { cve: "CVE-2026-0001" });
  return { team, findingId: finding.id };
}

/** A Fix PR as GitHub would answer it for PR `number`. */
const pr = (findingId: string, number: number, openedBy = ADMIN) => ({
  findingId,
  url: `https://github.com/example/app/pull/${number}`,
  number,
  branch: `warden/fix-${number}`,
  openedBy,
});

/** The Team's `fix_prs` rows, oldest first, read as that Team. */
const rows = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("fix_prs").selectAll().orderBy("id").execute());

describe("record and newest", () => {
  it("records a PR and answers it, with who opened it and when, as the newest for its Finding", async () => {
    const { team, findingId } = await teamWithFinding();

    const recorded = await fixPrs.record(team, pr(findingId, 7));

    expect(recorded).toEqual({ ...pr(findingId, 7), openedAt: expect.any(Date) });
    expect(await fixPrs.newest(team, findingId)).toEqual(recorded);
    expect(await rows(team)).toMatchObject([
      {
        team_id: team,
        finding_id: findingId,
        url: recorded.url,
        number: 7,
        branch: recorded.branch,
        opened_by: ADMIN,
        at: recorded.openedAt,
      },
    ]);
  });

  it("answers the newest of a Finding's PRs", async () => {
    const { team, findingId } = await teamWithFinding();
    await fixPrs.record(team, pr(findingId, 3));
    const later = await fixPrs.record(team, pr(findingId, 2));

    expect(await fixPrs.newest(team, findingId)).toEqual(later);
  });

  it("answers undefined for a Finding with no PR, though another Finding of the Team has one", async () => {
    const { team, findingId } = await teamWithFinding();
    const other = await seedPatchFinding(withTeam, team, randomUUID(), { cve: "CVE-2026-0002" });
    await fixPrs.record(team, pr(other.id, 1));

    expect(await fixPrs.newest(team, findingId)).toBeUndefined();
  });

  it("writes one row for the same PR recorded twice, and answers the held row", async () => {
    const { team, findingId } = await teamWithFinding();
    const first = await fixPrs.record(team, pr(findingId, 9));

    const second = await fixPrs.record(team, pr(findingId, 9, "user_other"));

    expect(second).toEqual(first);
    expect(await rows(team)).toHaveLength(1);
  });

  it("writes one row for the same PR recorded at once, and answers each the same row", async () => {
    const { team, findingId } = await teamWithFinding();

    const recorded = await Promise.all(
      Array.from({ length: 5 }, () => fixPrs.record(team, pr(findingId, 4))),
    );

    expect(await rows(team)).toHaveLength(1);
    for (const each of recorded) expect(each).toEqual(recorded[0]);
  });
});

describe("the key to findings", () => {
  it("refuses a PR for a Finding no Team has, and adds no row", async () => {
    const { team } = await teamWithFinding();

    await expect(fixPrs.record(team, pr(randomUUID(), 1))).rejects.toThrow(/fix_prs_finding/);

    expect(await rows(team)).toEqual([]);
  });

  it("refuses Team B's PR for Team A's Finding, and adds no row to either", async () => {
    const a = await teamWithFinding();
    const teamB = await newTeam(withTeam);

    await expect(fixPrs.record(teamB, pr(a.findingId, 1))).rejects.toThrow(/fix_prs_finding/);

    expect(await rows(teamB)).toEqual([]);
    expect(await rows(a.team)).toEqual([]);
  });
});

describe("Teams apart (ADR 0006)", () => {
  it("answers Team B none of Team A's PRs, and shows Team B none of its rows", async () => {
    const a = await teamWithFinding();
    await fixPrs.record(a.team, pr(a.findingId, 1));
    const teamB = await newTeam(withTeam);

    expect(await fixPrs.newest(teamB, a.findingId)).toBeUndefined();
    expect(
      await withTeam(teamB, (tx) =>
        tx.selectFrom("fix_prs").selectAll().where("finding_id", "=", a.findingId).execute(),
      ),
    ).toEqual([]);
    expect(await rows(a.team)).toHaveLength(1);
  });

  it("refuses a row Team B writes straight into the table naming Team A", async () => {
    const a = await teamWithFinding();
    const teamB = await newTeam(withTeam);

    await expect(
      withTeam(teamB, (tx) =>
        tx
          .insertInto("fix_prs")
          .values({
            team_id: a.team,
            finding_id: a.findingId,
            url: "https://github.com/example/app/pull/1",
            number: 1,
            branch: "warden/fix-1",
            opened_by: ADMIN,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await rows(a.team)).toEqual([]);
  });
});

describe("the table's checks", () => {
  it.each<[string, { number?: number; openedBy?: string }, RegExp]>([
    ["a PR number of 0", { number: 0 }, /number_check/],
    ["a negative PR number", { number: -3 }, /number_check/],
    ["a blank opened_by", { openedBy: " " }, /opened_by_check/],
    ["an empty opened_by", { openedBy: "" }, /opened_by_check/],
  ])("refuses %s, and adds no row", async (_name, { number = 1, openedBy = ADMIN }, check) => {
    const { team, findingId } = await teamWithFinding();

    await expect(fixPrs.record(team, pr(findingId, number, openedBy))).rejects.toThrow(check);

    expect(await rows(team)).toEqual([]);
  });
});
