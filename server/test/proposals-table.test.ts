// A Proposal is decided once and then kept as it is (0006_proposals, ADR 0008): Postgres refuses an update to a decided
// Proposal, a change to a pending one's own fields, and every delete and truncate, for warden_app and for the tables'
// owner, warden_migrate. warden_app has no delete or truncate grant, so Postgres refuses those first; the triggers
// refuse the rest. Deciding a pending one (its state and decided_* columns) is the one update allowed.
import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs, type DatabaseRole } from "./databases.ts";

const team = `org_proposals_${randomUUID()}`;
const pools: pg.Pool[] = [];
const withTeamAs = {} as Record<"warden_app" | "warden_migrate", WithTeam>;

const finding = (id: string) => ({
  team_id: team,
  id,
  asset_kind: "repo" as const,
  asset_ref: "https://github.com/example/app",
  module: "guard" as const,
  rule_id: "guard/agent-can-read-env",
  fingerprint: `guard/agent-can-read-env|file:${id}`,
  location: JSON.stringify({ kind: "file", path: id }),
  severity: "high" as const,
  title: "The agent can read .env files",
  evidence: JSON.stringify({ summary: "permissions.allow lets the agent read .env" }),
  control: null,
  status: "open" as const,
  unconfirmed_fix: null,
  accepted_reason: null,
  accepted_until: null,
  first_seen_scan: "scan-1",
  last_seen_scan: "scan-1",
  moved_to: null,
});

/** A pending Proposal to mark f-1 a False positive, written as warden_app. */
const pending = (id: string) =>
  withTeamAs.warden_app(team, (tx) =>
    tx
      .insertInto("proposals")
      .values({
        team_id: team,
        id,
        finding_id: "f-1",
        decision: "mark_false_positive",
        reason: "A test fixture",
        accepted_until: null,
        requested_by_kind: "agent",
        requested_by_id: "guard-bot",
      })
      .execute(),
  );

/** Decides a pending Proposal, as the Findings module does: only state and the decided_* columns. */
const decide = (id: string, role: "warden_app" | "warden_migrate" = "warden_app") =>
  withTeamAs[role](team, (tx) =>
    tx
      .updateTable("proposals")
      .set({ state: "approved", decided_by: "user_lead", decided_at: sql<Date>`now()` })
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );

beforeAll(async () => {
  for (const role of ["warden_app", "warden_migrate"] as const satisfies DatabaseRole[]) {
    const pool = poolAs(role, inject("testDatabase"));
    pools.push(pool);
    withTeamAs[role] = createWithTeam(pool);
  }
  await withTeamAs.warden_app(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    await tx
      .insertInto("findings")
      .values([finding("f-1"), finding("f-2")])
      .execute();
  });
  await pending("p-pending");
  await pending("p-decided");
  await decide("p-decided");
});

afterAll(async () => {
  for (const pool of pools) await pool.end();
});

const rows = () =>
  withTeamAs.warden_app(team, (tx) =>
    tx.selectFrom("proposals").selectAll().orderBy("id").execute(),
  );

const attempts: Record<string, { statement: RawBuilder<unknown>; app: RegExp; owner: RegExp }> = {
  "an update to a decided Proposal": {
    statement: sql`update proposals set decided_reason = null, state = 'pending', decided_by = null,
                   decided_at = null where id = 'p-decided'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "a change to a pending Proposal's reason": {
    statement: sql`update proposals set reason = 'rewritten' where id = 'p-pending'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "a change to a pending Proposal's finding_id": {
    statement: sql`update proposals set finding_id = 'f-2' where id = 'p-pending'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "a delete": {
    statement: sql`delete from proposals`,
    app: /permission denied for table proposals/,
    owner: /proposals keeps every Proposal: DELETE is refused/,
  },
  "a truncate": {
    statement: sql`truncate proposals cascade`,
    app: /permission denied for table proposals/,
    owner: /proposals keeps every Proposal: TRUNCATE is refused/,
  },
};

describe("a Proposal is decided once and then kept", () => {
  it.each(Object.keys(attempts))("refuses warden_app %s, and no row changes", async (name) => {
    const before = await rows();
    expect(before).toHaveLength(2);

    await expect(
      withTeamAs.warden_app(team, (tx) => attempts[name]!.statement.execute(tx)),
    ).rejects.toThrow(attempts[name]!.app);

    expect(await rows()).toEqual(before);
  });

  it.each(Object.keys(attempts))(
    "refuses the owner's (warden_migrate's) %s, and no row changes",
    async (name) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[name]!.statement.execute(tx)),
      ).rejects.toThrow(attempts[name]!.owner);

      expect(await rows()).toEqual(before);
    },
  );

  it("takes a pending Proposal's state and decided_* columns, once", async () => {
    await pending("p-once");

    await decide("p-once");

    const decided = (await rows()).find((row) => row.id === "p-once");
    expect(decided).toMatchObject({ state: "approved", decided_by: "user_lead" });
    await expect(decide("p-once")).rejects.toThrow(/a Proposal is decided once/);
  });

  it("refuses a decided state without decided_by, and decided_by on a pending one", async () => {
    await pending("p-half");
    const before = await rows();

    await expect(
      withTeamAs.warden_app(team, (tx) =>
        tx.updateTable("proposals").set({ state: "approved" }).where("id", "=", "p-half").execute(),
      ),
    ).rejects.toThrow(/proposals_decided_check/);
    await expect(
      withTeamAs.warden_app(team, (tx) =>
        tx
          .updateTable("proposals")
          .set({ decided_by: "user_lead" })
          .where("id", "=", "p-half")
          .execute(),
      ),
    ).rejects.toThrow(/proposals_decided_check/);

    expect(await rows()).toEqual(before);
  });
});
