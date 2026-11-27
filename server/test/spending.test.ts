// A Team's spending ledger (spec #225, slice 7a, story 10): the shared spending store records one row per paid model
// call and sums the Team's spending since the start of the current UTC day, which the per-Team limit reads. On the
// suite's shared database, each case with Teams of its own.
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createSpending, type Spending, type SpendingEntry } from "../src/spending.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { newTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let spending: Spending;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  spending = createSpending({ withTeam });
});

afterAll(() => pool.end());

const entry = (costUsd: number, more: Partial<SpendingEntry> = {}): SpendingEntry => ({
  path: "judge",
  model: "test/judge-model",
  inputTokens: 1200,
  outputTokens: 80,
  costUsd,
  costBasis: "stated",
  ...more,
});

/** The Team's ledger rows, oldest first, read as that Team. */
const rows = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("spending_ledger").selectAll().orderBy("id").execute());

describe("the spending store", () => {
  it("records a paid call's path, model, tokens, cost and whether the cost was stated", async () => {
    const team = await newTeam(withTeam);

    await spending.record(team, entry(0.00123));
    await spending.record(
      team,
      entry(0.05, { inputTokens: null, outputTokens: null, costBasis: "assumed" }),
    );

    expect(await rows(team)).toEqual([
      expect.objectContaining({
        team_id: team,
        path: "judge",
        model: "test/judge-model",
        input_tokens: 1200,
        output_tokens: 80,
        cost_usd: "0.00123",
        cost_basis: "stated",
        at: expect.any(Date),
      }),
      expect.objectContaining({
        input_tokens: null,
        output_tokens: null,
        cost_usd: "0.05",
        cost_basis: "assumed",
      }),
    ]);
  });

  it("answers 0 for a Team that has spent nothing", async () => {
    expect(await spending.spentToday(await newTeam(withTeam))).toBe(0);
  });

  it("sums today's spending on every path, leaving out yesterday's (UTC) and another Team's", async () => {
    const team = await newTeam(withTeam);
    const other = await newTeam(withTeam);
    await spending.record(team, entry(0.25));
    await spending.record(team, entry(0.05, { costBasis: "assumed" }));
    await spending.record(other, entry(0.5));
    // A call a second before today began, and one at its first instant, in UTC.
    const startOfToday = sql<Date>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
    await withTeam(team, (tx) =>
      tx
        .insertInto("spending_ledger")
        .values([
          {
            team_id: team,
            at: sql<Date>`${startOfToday} - interval '1 second'`,
            path: "judge",
            model: "test/judge-model",
            input_tokens: null,
            output_tokens: null,
            cost_usd: 0.75,
            cost_basis: "stated",
          },
          {
            team_id: team,
            at: startOfToday,
            path: "judge",
            model: "test/judge-model",
            input_tokens: null,
            output_tokens: null,
            cost_usd: 0.125,
            cost_basis: "stated",
          },
        ])
        .execute(),
    );

    expect(await spending.spentToday(team)).toBeCloseTo(0.425, 9);
    expect(await spending.spentToday(other)).toBeCloseTo(0.5, 9);
  });
});
