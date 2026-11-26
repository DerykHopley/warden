// The review log's reads (spec #341, slice 3, stories 6 and 7): the Controls list reads only each Control's newest
// review, and the one-Control read only that Control's reviews, newest first, so neither loads the whole Catalogue's
// log. Newest is the latest `reviewed_at`, then the highest id; each review is stamped when it is written, so the two
// agree. On the suite's shared database, each case with a Team of its own.
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createControlReviews, type ControlReviews } from "../src/modules/vouch/control-reviews.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { newTeam } from "./helpers.ts";

const LEAD = "user_lead";
const ADMIN = "user_admin";
const ISA = "vda-isa-2027.1";

let pool: pg.Pool;
let withTeam: WithTeam;
let controlReviews: ControlReviews;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  controlReviews = createControlReviews({ withTeam });
});

afterAll(() => pool.end());

const confirm = (team: string, controlRef: string, reason: string, reviewedBy = LEAD) =>
  controlReviews.add(team, {
    catalogue: ISA,
    controlRef,
    workedOutVerdict: "not_evidenced",
    outcome: "confirmed",
    verdict: "not_evidenced",
    reason,
    reviewedBy,
  });

describe("newest: each reviewed Control's newest review", () => {
  it("answers one review per Control, its newest, and none for a Control never reviewed", async () => {
    const team = await newTeam(withTeam);
    await confirm(team, "1.3.3", "first of 1.3.3");
    await confirm(team, "4.1.3", "only one of 4.1.3");
    await confirm(team, "1.3.3", "second of 1.3.3", ADMIN);

    const newest = await controlReviews.newest(team, ISA);

    expect(newest).toMatchObject([
      { controlRef: "1.3.3", reason: "second of 1.3.3", reviewedBy: ADMIN },
      { controlRef: "4.1.3", reason: "only one of 4.1.3" },
    ]);
  });

  it("answers a Team with no reviews none", async () => {
    expect(await controlReviews.newest(await newTeam(withTeam), ISA)).toEqual([]);
  });
});

describe("history: one Control's reviews", () => {
  it("answers only that Control's reviews, newest first", async () => {
    const team = await newTeam(withTeam);
    await confirm(team, "1.3.3", "first of 1.3.3");
    await confirm(team, "4.1.3", "only one of 4.1.3");
    await confirm(team, "1.3.3", "second of 1.3.3");

    const history = await controlReviews.history(team, ISA, "1.3.3");

    expect(history.map(({ controlRef, reason }) => [controlRef, reason])).toEqual([
      ["1.3.3", "second of 1.3.3"],
      ["1.3.3", "first of 1.3.3"],
    ]);
  });
});

describe("when a review is stamped", () => {
  it("stamps each review when it is written, not when its transaction began, so time and id order agree", async () => {
    const team = await newTeam(withTeam);

    const stamps = await withTeam(team, async (tx) => {
      for (const reason of ["written first", "written second"]) {
        await tx
          .insertInto("control_reviews")
          .values({
            team_id: team,
            catalogue: ISA,
            control_ref: "1.3.3",
            worked_out_verdict: "not_evidenced",
            outcome: "confirmed",
            verdict: "not_evidenced",
            reason,
            reviewed_by: LEAD,
          })
          .execute();
        await sql`select pg_sleep(0.01)`.execute(tx);
      }
      // Compared in the database: a JavaScript Date drops the microseconds.
      return sql<{ later: boolean }>`
        select (max(reviewed_at) filter (where reason = 'written second'))
             > (max(reviewed_at) filter (where reason = 'written first')) as later
        from control_reviews`.execute(tx);
    });

    expect(stamps.rows).toEqual([{ later: true }]);
  });
});
