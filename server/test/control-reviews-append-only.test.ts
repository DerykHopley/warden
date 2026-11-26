// The review log (spec #341, slice 3, stories 6 and 10): a Control's reviews can't be edited, by the app or by the
// table's owner, as a Finding's history can't (finding-history.test.ts). warden_app has no update, delete or truncate
// grant on it, so Postgres refuses those first; the owner, warden_migrate, has every grant, and the append-only trigger
// refuses it. The table's checks refuse an override with no reason and a worked-out Verdict a worked-out one can't be,
// and row-level security keeps each Team to its own rows. It runs on a database of its own: the owner's truncate locks
// the table against every other file writing reviews on the suite's shared database.
import type { ReviewedVerdict, ReviewOutcome, Verdict } from "@warden/contracts";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlReviews } from "../src/modules/vouch/control-reviews.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { newTeam } from "./helpers.ts";

const LEAD = "user_lead";
const ISA = "vda-isa-2027.1";

let teamA: string;
let teamB: string;
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  teamA = await newTeam(withTeamAs.warden_app);
  teamB = await newTeam(withTeamAs.warden_app);
  await createControlReviews({ withTeam: withTeamAs.warden_app }).add(teamA, {
    catalogue: ISA,
    controlRef: "1.3.3",
    workedOutVerdict: "evidenced",
    outcome: "confirmed",
    verdict: "evidenced",
    reason: null,
    reviewedBy: LEAD,
  });
}, 30_000);

afterAll(() => end?.(), 30_000);

/** Every `control_reviews` row `team` can see, with no `where`, oldest first. */
const rows = (team = teamA) =>
  withTeamAs.warden_app(team, (tx) =>
    tx.selectFrom("control_reviews").selectAll().orderBy("id").execute(),
  );

/** A row written straight into the table as warden_app, under `team`'s `withTeam`. The fields may be ones the types
 * refuse, to show the database refuses them too. */
const insert = (
  team: string,
  fields: {
    worked_out_verdict?: string;
    outcome?: string;
    verdict?: string;
    reason?: string | null;
  },
) =>
  withTeamAs.warden_app(team, (tx) =>
    tx
      .insertInto("control_reviews")
      .values({
        team_id: team,
        catalogue: ISA,
        control_ref: "4.1.3",
        reviewed_by: LEAD,
        reason: null,
        ...fields,
        worked_out_verdict: (fields.worked_out_verdict ?? "partly_evidenced") as Verdict,
        outcome: (fields.outcome ?? "confirmed") as ReviewOutcome,
        verdict: (fields.verdict ?? "partly_evidenced") as ReviewedVerdict,
      })
      .execute(),
  );

const attempts = {
  update: sql`update control_reviews set verdict = 'not_applicable', outcome = 'overridden', reason = 'rewritten'`,
  delete: sql`delete from control_reviews`,
  truncate: sql`truncate control_reviews`,
};

describe("control_reviews is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(teamA, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table control_reviews/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(teamA, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/control_reviews is append-only/);

      expect(await rows()).toEqual(before);
    },
  );
});

describe("the table's checks", () => {
  it.each<[string, Parameters<typeof insert>[1], RegExp]>([
    [
      "an override with no reason",
      { outcome: "overridden", verdict: "not_applicable", reason: null },
      /control_reviews_override_reason/,
    ],
    [
      "an override with a blank reason",
      { outcome: "overridden", verdict: "not_applicable", reason: " \t" },
      /control_reviews_reason_check/,
    ],
    [
      "a worked-out Verdict of not_applicable",
      { worked_out_verdict: "not_applicable", verdict: "not_applicable" },
      /control_reviews_worked_out_verdict_check/,
    ],
    [
      "a confirm that gives another Verdict than the worked-out one",
      { outcome: "confirmed", verdict: "evidenced" },
      /control_reviews_outcome_matches/,
    ],
    [
      "an override that gives the worked-out Verdict",
      { outcome: "overridden", verdict: "partly_evidenced", reason: "No change" },
      /control_reviews_outcome_matches/,
    ],
  ])("refuses %s, and adds no row", async (_name, fields, check) => {
    const team = await newTeam(withTeamAs.warden_app);

    await expect(insert(team, fields)).rejects.toThrow(check);
    expect(await rows(team)).toEqual([]);
  });

  it("takes an override to not_applicable with a reason", async () => {
    const team = await newTeam(withTeamAs.warden_app);

    await insert(team, {
      outcome: "overridden",
      verdict: "not_applicable",
      reason: "No AI tools in this Team",
    });

    expect(await rows(team)).toMatchObject([{ verdict: "not_applicable", outcome: "overridden" }]);
  });
});

describe("Teams apart (ADR 0006, story 10)", () => {
  it("answers Team B's select with no `where` none of Team A's rows", async () => {
    expect(await rows(teamA)).not.toHaveLength(0);

    expect(await rows(teamB)).toEqual([]);
  });

  it("refuses an insert under Team B naming Team A, and Team A's rows are unchanged", async () => {
    const before = await rows(teamA);

    await expect(
      withTeamAs.warden_app(teamB, (tx) =>
        tx
          .insertInto("control_reviews")
          .values({
            team_id: teamA,
            catalogue: ISA,
            control_ref: "1.3.3",
            worked_out_verdict: "evidenced",
            outcome: "confirmed",
            verdict: "evidenced",
            reason: null,
            reviewed_by: LEAD,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await rows(teamA)).toEqual(before);
  });
});
