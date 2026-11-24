// Story 5: a query that forgets its Team still can't reach another Team's rows. The team-scoping spike's attack cases
// (ADR 0006), run as warden_app unless a case says otherwise, in a fresh migrated database of this file's own with a
// test-only `test_notes` table built the way later Team-owned tables are: `team_id` in its keys and forced policies.
import { sql, type Generated, type PostgresPool, type Transaction } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import type { Database } from "../src/schema.ts";
import { createWithAdmin } from "../src/with-admin.ts";
import { createWithTeam } from "../src/with-team.ts";
import { createMigratedTestDatabase, poolAs } from "./databases.ts";
import { closedPort } from "./ports.ts";

/** `Database` plus the test-only table; it never goes in `Database`. */
interface TestDatabase extends Database {
  test_notes: {
    id: Generated<string>;
    team_id: string;
    kind: string;
    parent_id: string | null;
  };
}

const TEST_NOTES = `
create table test_notes (
  id bigint generated always as identity primary key,
  team_id text not null references teams (id),
  kind text not null,
  parent_id bigint,
  unique (team_id, id),
  foreign key (team_id, parent_id) references test_notes (team_id, id)
);
alter table test_notes enable row level security;
alter table test_notes force row level security;
create policy test_notes_team on test_notes for all
  using (team_id = current_setting('warden.team_id', true))
  with check (team_id = current_setting('warden.team_id', true));
`;

const A = "org_team_a";
const B = "org_team_b";

const logger = createLogger(() => {});
const ends: (() => Promise<unknown>)[] = [];
let databaseName: string;
let app: pg.Pool;
let withTeam: ReturnType<typeof createWithTeam<TestDatabase>>;
/** Each Team's notes by name, as seeded. */
const notes: Record<string, string> = {};

function track(pool: pg.Pool): pg.Pool {
  ends.push(() => pool.end());
  return pool;
}

async function seed(team: string, kinds: [name: string, kind: string, parent?: string][]) {
  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    for (const [name, kind, parent] of kinds) {
      const { id } = await tx
        .insertInto("test_notes")
        .values({ team_id: team, kind, parent_id: parent ? notes[parent] : null })
        .returning("id")
        .executeTakeFirstOrThrow();
      notes[name] = id;
    }
  });
}

/** An empty answer can mean "no Team set" as well as "nothing there" (ADR 0006): this proves the Team is set. */
async function expectTeamSet(tx: Transaction<TestDatabase>, team: string) {
  const { rows } = await sql<{
    team: string;
  }>`select current_setting('warden.team_id', true) as team`.execute(tx);
  expect(rows).toEqual([{ team }]);
  const own = await tx.selectFrom("teams").select("id").execute();
  expect(own).toEqual([{ id: team }]);
}

beforeAll(async () => {
  const database = await createMigratedTestDatabase();
  ends.push(database.drop);
  databaseName = database.name;
  const owner = track(poolAs("warden_migrate", database.name));
  await owner.query(TEST_NOTES);

  app = track(poolAs("warden_app", database.name));
  withTeam = createWithTeam<TestDatabase>(app);
  await seed(A, [
    ["a1", "finding"],
    ["a2", "finding", "a1"],
    ["a3", "note"],
  ]);
  await seed(B, [
    ["b1", "finding"],
    ["b2", "finding", "b1"],
    ["b3", "note"],
    ["b4", "note"],
  ]);
});

afterAll(async () => {
  for (const end of ends.splice(0).reverse()) await end();
});

const aNotes = () => [notes.a1, notes.a2, notes.a3].sort();

describe("the attack cases", () => {
  it("1: a query that forgets the Team reads only the Team's rows", async () => {
    const { teams, testNotes } = await withTeam(A, async (tx) => ({
      teams: await tx.selectFrom("teams").selectAll().execute(),
      testNotes: await tx.selectFrom("test_notes").selectAll().execute(),
    }));

    expect(teams.map((team) => team.id)).toEqual([A]);
    expect(testNotes.map((note) => note.id).sort()).toEqual(aNotes());
    expect(new Set(testNotes.map((note) => note.team_id))).toEqual(new Set([A]));
  });

  it("2: asking for another Team's rows by team_id returns nothing", async () => {
    const rows = await withTeam(A, async (tx) => {
      await expectTeamSet(tx, A);
      return {
        teams: await tx.selectFrom("teams").selectAll().where("id", "=", B).execute(),
        testNotes: await tx.selectFrom("test_notes").selectAll().where("team_id", "=", B).execute(),
      };
    });

    expect(rows).toEqual({ teams: [], testNotes: [] });
  });

  it("3: another Team's row by its id is not found, exactly as an id that exists nowhere", async () => {
    const byId = (id: string) =>
      withTeam(A, async (tx) => {
        await expectTeamSet(tx, A);
        return tx.selectFrom("test_notes").selectAll().where("id", "=", id).executeTakeFirst();
      });

    expect(await byId(notes.b1!)).toBeUndefined();
    expect(await byId("999999")).toBeUndefined();
  });

  it("4: a join whose condition omits the Team returns only the Team's rows", async () => {
    const { selfJoin, teamsJoin } = await withTeam(A, async (tx) => ({
      selfJoin: await tx
        .selectFrom("test_notes as child")
        .innerJoin("test_notes as parent", "child.parent_id", "parent.id")
        .select(["child.id as child", "parent.id as parent", "parent.team_id"])
        .execute(),
      teamsJoin: await tx
        .selectFrom("teams")
        .innerJoin("test_notes", (join) => join.on(sql<boolean>`true`))
        .select(["teams.id as team", "test_notes.id as note", "test_notes.team_id"])
        .execute(),
    }));

    expect(selfJoin).toEqual([{ child: notes.a2, parent: notes.a1, team_id: A }]);
    expect(teamsJoin.map((row) => row.note).sort()).toEqual(aNotes());
    expect(new Set(teamsJoin.flatMap((row) => [row.team, row.team_id]))).toEqual(new Set([A]));
  });

  it("5: an aggregate counts only the Team's rows", async () => {
    const counts = await withTeam(A, (tx) =>
      tx
        .selectFrom("test_notes")
        .select(["kind", (eb) => eb.fn.countAll<string>().as("count")])
        .groupBy("kind")
        .orderBy("kind")
        .execute(),
    );

    expect(counts).toEqual([
      { kind: "finding", count: "2" },
      { kind: "note", count: "1" },
    ]);
  });

  it("6: with no Team set, reads return no rows", async () => {
    expect((await app.query("select * from teams")).rows).toEqual([]);
    expect((await app.query("select * from test_notes")).rows).toEqual([]);
  });

  it("7: with no Team set, an insert is refused", async () => {
    await expect(app.query("insert into teams (id) values ('org_nobody')")).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      app.query("insert into test_notes (team_id, kind) values ($1, 'note')", [A]),
    ).rejects.toThrow(/row-level security/);
  });

  it("8: a write can't create a row for another Team", async () => {
    await expect(
      withTeam(A, (tx) =>
        tx.insertInto("test_notes").values({ team_id: B, kind: "note" }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTeam(A, (tx) => tx.insertInto("teams").values({ id: "org_team_c" }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it("9: a write can't move the Team's row to another Team", async () => {
    await expect(
      withTeam(A, (tx) =>
        tx.updateTable("test_notes").set({ team_id: B }).where("id", "=", notes.a3!).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("10: an update and a delete aimed at another Team's rows affect none of them", async () => {
    const bBefore = await withTeam(B, (tx) =>
      tx.selectFrom("test_notes").selectAll().orderBy("id").execute(),
    );

    const { updated, deleted } = await withTeam(A, async (tx) => {
      await expectTeamSet(tx, A);
      return {
        updated: await tx
          .updateTable("test_notes")
          .set({ kind: "changed" })
          .where("id", "=", notes.b3!)
          .executeTakeFirst(),
        deleted: await tx.deleteFrom("test_notes").where("id", "=", notes.b4!).executeTakeFirst(),
      };
    });

    expect(updated.numUpdatedRows).toBe(0n);
    expect(deleted.numDeletedRows).toBe(0n);
    const bAfter = await withTeam(B, (tx) =>
      tx.selectFrom("test_notes").selectAll().orderBy("id").execute(),
    );
    expect(bAfter).toEqual(bBefore);
    expect(bAfter).toHaveLength(4);
  });

  it("11: a pooled connection carries no Team past a withTeam, committed or thrown", async () => {
    const single = track(
      createPool(logger, { user: "warden_app", database: databaseName, max: 1 }),
    );
    const singleWithTeam = createWithTeam<TestDatabase>(single);
    const plainTeams = async () => (await single.query("select id from teams")).rows;

    await singleWithTeam(A, (tx) => tx.selectFrom("teams").selectAll().execute());
    expect(await plainTeams()).toEqual([]);

    // The throwing callback writes first: the rethrow is the same error, and the write is rolled back.
    const boom = new Error("callback failed after writing");
    await expect(
      singleWithTeam(A, async (tx) => {
        await tx.insertInto("test_notes").values({ team_id: A, kind: "rolled back" }).execute();
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await plainTeams()).toEqual([]);

    const seenByB = await singleWithTeam(B, (tx) => tx.selectFrom("teams").selectAll().execute());
    expect(seenByB.map((team) => team.id)).toEqual([B]);
    const rolledBack = await singleWithTeam(A, (tx) =>
      tx.selectFrom("test_notes").select("id").where("kind", "=", "rolled back").execute(),
    );
    expect(rolledBack).toEqual([]);
  });

  it("12: a parent from another Team is refused as if it existed nowhere", async () => {
    const refusal = async (parent: string) => {
      const error = await withTeam(A, (tx) =>
        tx
          .insertInto("test_notes")
          .values({ team_id: A, kind: "note", parent_id: parent })
          .execute(),
      ).catch((caught: unknown) => caught as pg.DatabaseError);
      expect(error).toBeInstanceOf(Error);
      const { code, constraint, message, detail } = error as pg.DatabaseError;
      return { code, constraint, message, detail: detail?.replace(parent, "<parent>") };
    };

    const crossTeam = await refusal(notes.b1!);
    const nowhere = await refusal("999999");

    expect(crossTeam.code).toBe("23503");
    expect(crossTeam).toEqual(nowhere);
  });

  it("13: the tables' owner, with no Team set, reads no rows", async () => {
    const owner = track(poolAs("warden_migrate", databaseName));

    expect((await owner.query("select * from teams")).rows).toEqual([]);
    expect((await owner.query("select * from test_notes")).rows).toEqual([]);
  });

  it("14: warden_app can't switch the policies off", async () => {
    await expect(app.query("alter table teams disable row level security")).rejects.toThrow(
      /must be owner/,
    );
    await expect(app.query("alter table teams no force row level security")).rejects.toThrow(
      /must be owner/,
    );
    const { rows } = await app.query<{ policyname: string }>(
      "select policyname from pg_policies where tablename = 'teams'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { policyname } of rows) {
      await expect(app.query(`drop policy ${policyname} on teams`)).rejects.toThrow(
        /must be owner/,
      );
    }
  });

  it.each(["", "  ", ` ${A}`, `${A} `])(
    "15: withTeam(%j) refuses before touching the database",
    async (team) => {
      const touched: string[] = [];
      const pool: PostgresPool = {
        options: {},
        connect: async () => {
          touched.push("connect");
          throw new Error("no database here");
        },
        end: async () => {},
      };
      let ran = false;

      await expect(
        createWithTeam(pool)(team, async () => {
          ran = true;
        }),
      ).rejects.toThrow(/Team/);
      expect(touched).toEqual([]);
      expect(ran).toBe(false);
    },
  );
});

describe("withTeam", () => {
  it("rejects with the driver's error when the database can't be reached", async () => {
    const unreachable = track(
      createPool(logger, { host: "127.0.0.1", port: await closedPort(), max: 1 }),
    );

    await expect(
      createWithTeam(unreachable)(A, (tx) => tx.selectFrom("teams").selectAll().execute()),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("withAdmin", () => {
  it("sees Team A's and Team B's rows in one call", async () => {
    const withAdmin = createWithAdmin(track(poolAs("warden_admin", databaseName)));

    const ids = await withAdmin(async (tx) =>
      (await tx.selectFrom("teams").select("id").execute()).map((team) => team.id),
    );

    expect(ids.sort()).toEqual([A, B]);
  });

  it("runs read-only, so a write inside it fails", async () => {
    const withAdmin = createWithAdmin(track(poolAs("warden_admin", databaseName)));

    await expect(
      withAdmin((tx) => tx.insertInto("teams").values({ id: "org_team_admin_made" }).execute()),
    ).rejects.toThrow(/read-only transaction/);
  });
});
