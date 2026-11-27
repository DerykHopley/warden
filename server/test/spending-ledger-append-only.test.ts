// A Team's spending ledger can't be edited, by the app or by the table's owner, and each Team reads only its own rows
// (spec #225, slice 7a, threat J5), as `fix_prs` can't be edited (fix-prs-append-only.test.ts). warden_app has no
// update, delete or truncate grant on it, so Postgres refuses those first; the owner, warden_migrate, has every grant,
// and the append-only trigger refuses it. It runs on a database of its own: the owner's truncate locks the table
// against every other file recording spending on the shared one.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpending } from "../src/spending.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";

const team = `org_spending_${randomUUID()}`;
const teamB = `org_spending_b_${randomUUID()}`;
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  for (const id of [team, teamB]) {
    await withTeamAs.warden_app(id, (tx) => tx.insertInto("teams").values({ id }).execute());
  }
  await createSpending({ withTeam: withTeamAs.warden_app }).record(team, {
    path: "judge",
    model: "test/judge-model",
    inputTokens: 1200,
    outputTokens: 80,
    costUsd: 0.002,
    costBasis: "stated",
  });
}, 30_000);

afterAll(() => end?.(), 30_000);

const rows = (as: string = team) =>
  withTeamAs.warden_app(as, (tx) =>
    tx.selectFrom("spending_ledger").selectAll().orderBy("id").execute(),
  );

const attempts = {
  update: sql`update spending_ledger set cost_usd = 0`,
  delete: sql`delete from spending_ledger`,
  truncate: sql`truncate spending_ledger`,
};

describe("spending_ledger is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table spending_ledger/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/spending_ledger is append-only/);

      expect(await rows()).toEqual(before);
    },
  );
});

describe("spending_ledger is Team-owned", () => {
  it("shows Team B none of Team A's rows, and refuses a row Team B writes for Team A", async () => {
    expect(await rows(teamB)).toEqual([]);

    await expect(
      withTeamAs.warden_app(teamB, (tx) =>
        tx
          .insertInto("spending_ledger")
          .values({
            team_id: team,
            path: "judge",
            model: "test/judge-model",
            input_tokens: null,
            output_tokens: null,
            cost_usd: 1,
            cost_basis: "assumed",
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await rows()).toHaveLength(1);
  });
});
