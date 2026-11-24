// Story 8: a Finding's history can't be edited, by the app or by the tables' owner (threat D6). warden_app has no
// update, delete or truncate grant on it, so Postgres refuses those first; the owner, warden_migrate, has every grant,
// and the append-only trigger refuses it.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs, type DatabaseRole } from "./databases.ts";

const team = `org_history_${randomUUID()}`;
const pools: pg.Pool[] = [];
const withTeamAs = {} as Record<"warden_app" | "warden_migrate", WithTeam>;

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
      .values({
        team_id: team,
        id: "f-1",
        asset_kind: "repo",
        asset_ref: "https://github.com/example/app",
        module: "guard",
        rule_id: "guard/agent-can-read-env",
        fingerprint: "guard/agent-can-read-env|file:.env",
        location: JSON.stringify({ kind: "file", path: ".env" }),
        severity: "high",
        title: "The agent can read .env files",
        evidence: JSON.stringify({ summary: "permissions.allow lets the agent read .env" }),
        control: null,
        status: "open",
        unconfirmed_fix: null,
        accepted_reason: null,
        accepted_until: null,
        first_seen_scan: "scan-1",
        last_seen_scan: "scan-1",
        moved_to: null,
      })
      .execute();
    await tx
      .insertInto("finding_history")
      .values({
        team_id: team,
        finding_id: "f-1",
        status_before: null,
        status_after: "open",
        severity_before: null,
        severity_after: "high",
        actor_kind: "scan",
        actor_id: "scan-1",
        reason: "opened by Scan scan-1",
      })
      .execute();
  });
});

afterAll(async () => {
  for (const pool of pools) await pool.end();
});

const rows = () =>
  withTeamAs.warden_app(team, (tx) =>
    tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
  );

const attempts = {
  update: sql`update finding_history set reason = 'rewritten', status_after = 'fixed'`,
  delete: sql`delete from finding_history`,
  truncate: sql`truncate finding_history`,
};

describe("finding_history is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table finding_history/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/finding_history is append-only/);

      expect(await rows()).toEqual(before);
    },
  );

  it("still takes a new row from warden_app", async () => {
    await withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("finding_history")
        .values({
          team_id: team,
          finding_id: "f-1",
          status_before: "open",
          status_after: "fixed",
          severity_before: "high",
          severity_after: "high",
          actor_kind: "scan",
          actor_id: "scan-2",
          reason: "not seen by Scan scan-2",
        })
        .execute(),
    );

    expect((await rows()).map((row) => row.actor_id)).toEqual(["scan-1", "scan-2"]);
  });
});
