// The two tables 0004_team_members makes (ADR 0008): each person's Role in a Team, and the append-only history of
// every Role change. The history can't be edited, by the app or by the tables' owner (threat D6): warden_app has no
// update, delete or truncate grant on it, and the append-only trigger refuses the owner, warden_migrate.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs, type DatabaseRole } from "./databases.ts";

const team = `org_roles_${randomUUID()}`;
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
      .insertInto("team_members")
      .values({ team_id: team, user_id: "user_admin", role: "admin" })
      .execute();
    await tx
      .insertInto("role_history")
      .values({
        team_id: team,
        user_id: "user_admin",
        role_before: null,
        role_after: "admin",
        change: "created_team",
        actor_id: "user_admin",
      })
      .execute();
  });
});

afterAll(async () => {
  for (const pool of pools) await pool.end();
});

describe("0004_team_members", () => {
  it("makes team_members and role_history with the approved columns", async () => {
    const { rows } = await pools[0]!.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      identity_generation: string | null;
    }>(`
      select table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation
        from information_schema.columns
       where table_schema = 'public' and table_name in ('team_members', 'role_history')
       order by table_name, ordinal_position
    `);
    const columns = rows.map((c) => ({
      table: c.table_name,
      column: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === "YES",
      default: c.column_default,
      identity: c.is_identity === "YES" ? c.identity_generation : null,
    }));

    const column = (table: string, name: string, type: string, nullable = false) => ({
      table,
      column: name,
      type,
      nullable,
      default: null,
      identity: null,
    });
    expect(columns).toEqual([
      column("role_history", "team_id", "text"),
      { ...column("role_history", "id", "bigint"), identity: "ALWAYS" },
      column("role_history", "user_id", "text"),
      column("role_history", "role_before", "text", true),
      column("role_history", "role_after", "text"),
      column("role_history", "change", "text"),
      column("role_history", "actor_id", "text"),
      { ...column("role_history", "at", "timestamp with time zone"), default: "now()" },
      column("team_members", "team_id", "text"),
      column("team_members", "user_id", "text"),
      column("team_members", "role", "text"),
      { ...column("team_members", "joined_at", "timestamp with time zone"), default: "now()" },
    ]);
  });

  it("keys each table by the Team, and points both at teams", async () => {
    const { rows } = await pools[0]!.query<{ table: string; kind: string; definition: string }>(`
      select conrelid::regclass::text as table, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid in ('team_members'::regclass, 'role_history'::regclass) and contype in ('p', 'f')
       order by 1, 2, 3
    `);

    expect(rows).toEqual([
      {
        table: "role_history",
        kind: "f",
        definition: "FOREIGN KEY (team_id) REFERENCES teams(id)",
      },
      { table: "role_history", kind: "p", definition: "PRIMARY KEY (team_id, id)" },
      {
        table: "team_members",
        kind: "f",
        definition: "FOREIGN KEY (team_id) REFERENCES teams(id)",
      },
      { table: "team_members", kind: "p", definition: "PRIMARY KEY (team_id, user_id)" },
    ]);
  });

  it.each([
    ["a Role outside the three", { user_id: "user_x", role: "owner" }],
    ["a blank user id", { user_id: "  ", role: "member" }],
  ])("refuses a team_members row with %s", async (_name, values) => {
    await expect(
      withTeamAs.warden_app(team, (tx) =>
        tx
          .insertInto("team_members")
          .values({ team_id: team, ...values } as never)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it.each([
    ["a role_after outside the three", { role_after: "owner" }],
    ["a role_before outside the three", { role_before: "owner" }],
    ["a change outside the three", { change: "promoted" }],
    ["a blank user id", { user_id: " " }],
    ["a blank actor id", { actor_id: "" }],
  ])("refuses a role_history row with %s", async (_name, values) => {
    await expect(
      withTeamAs.warden_app(team, (tx) =>
        tx
          .insertInto("role_history")
          .values({
            team_id: team,
            user_id: "user_x",
            role_before: null,
            role_after: "member",
            change: "joined",
            actor_id: "user_x",
            ...values,
          } as never)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

const rows = () =>
  withTeamAs.warden_app(team, (tx) =>
    tx.selectFrom("role_history").selectAll().orderBy("id").execute(),
  );

const attempts = {
  update: sql`update role_history set role_after = 'member'`,
  delete: sql`delete from role_history`,
  truncate: sql`truncate role_history`,
};

describe("role_history is append-only", () => {
  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the row is unchanged",
    async (command) => {
      const before = await rows();
      expect(before).toHaveLength(1);

      await expect(
        withTeamAs.warden_app(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/permission denied for table role_history/);

      expect(await rows()).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the row is unchanged",
    async (command) => {
      const before = await rows();

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/role_history is append-only/);

      expect(await rows()).toEqual(before);
    },
  );

  it("still takes a new row from warden_app", async () => {
    await withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("role_history")
        .values({
          team_id: team,
          user_id: "user_member",
          role_before: null,
          role_after: "member",
          change: "joined",
          actor_id: "user_member",
        })
        .execute(),
    );

    expect((await rows()).map((row) => row.change)).toEqual(["created_team", "joined"]);
  });
});
