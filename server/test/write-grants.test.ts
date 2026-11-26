// A Team's write grants (#224, stories 5 and 15): who granted Warden's write GitHub app on which installation, kept as
// an append-only record of `granted` and `revoked` events, stored by the Guard module's store on the suite's shared
// database through withTeam. Each case has Teams and installation ids of its own, so files running at once never meet.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { InstallationLinkedElsewhere } from "../src/modules/guard/repo-assets.ts";
import { createWriteGrants, type WriteGrants } from "../src/modules/guard/write-grants.ts";
import type { WriteGrantEvent } from "../src/schema.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, newInstallation, newTeam, queuedBehindLock } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let writeGrants: WriteGrants;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  writeGrants = createWriteGrants({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

/** The Team's write-grant rows, oldest first, read as that Team. */
const rows = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("github_write_grants").selectAll().orderBy("id").execute());

/** Writes a row straight into the table under the Team, past the store's checks. */
const insertRow = (
  team: string,
  row: { installationId: number; event: WriteGrantEvent; causedBy?: string; teamId?: string },
) =>
  withTeam(team, (tx) =>
    tx
      .insertInto("github_write_grants")
      .values({
        team_id: row.teamId ?? team,
        installation_id: row.installationId,
        event: row.event,
        caused_by: row.causedBy ?? ADMIN,
      })
      .execute(),
  );

describe("grant and list", () => {
  it("records the grant and lists the installation with who granted it and when", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();

    const grant = await writeGrants.grant(team, { installationId, grantedBy: ADMIN });

    expect(grant).toEqual({ installationId, grantedBy: ADMIN, grantedAt: expect.any(Date) });
    expect(await writeGrants.list(team)).toEqual([grant]);
    expect(await rows(team)).toMatchObject([
      { team_id: team, event: "granted", caused_by: ADMIN, at: grant.grantedAt },
    ]);
  });

  it("writes no row for a second grant of an installation already granted, and answers the first", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const first = await writeGrants.grant(team, { installationId, grantedBy: ADMIN });

    const second = await writeGrants.grant(team, { installationId, grantedBy: "user_other_admin" });

    expect(second).toEqual(first);
    expect(await rows(team)).toHaveLength(1);
    expect(await writeGrants.list(team)).toEqual([first]);
  });

  it("writes one row for grants of one installation made at once, and answers each the same grant", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();

    const grants = await Promise.all(
      Array.from({ length: 5 }, () =>
        writeGrants.grant(team, { installationId, grantedBy: ADMIN }),
      ),
    );

    expect(await rows(team)).toHaveLength(1);
    for (const grant of grants) expect(grant).toEqual(grants[0]);
  });

  it("lists a Team's installations by installation id", async () => {
    const team = await newTeam(withTeam);
    const [a, b] = [newInstallation(), newInstallation()];
    const [low, high] = [Math.min(a, b), Math.max(a, b)];
    await writeGrants.grant(team, { installationId: high, grantedBy: ADMIN });
    await writeGrants.grant(team, { installationId: low, grantedBy: ADMIN });

    expect((await writeGrants.list(team)).map((grant) => grant.installationId)).toEqual([
      low,
      high,
    ]);
  });

  it("lists nothing for a Team with no grant", async () => {
    expect(await writeGrants.list(await newTeam(withTeam))).toEqual([]);
  });

  it("doesn't list an installation whose newest row is revoked, and a later grant writes a new row that lists it", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
    await insertRow(team, { installationId, event: "revoked", causedBy: "user_member" });

    expect(await writeGrants.list(team)).toEqual([]);

    const regrant = await writeGrants.grant(team, {
      installationId,
      grantedBy: "user_other_admin",
    });

    expect(regrant).toEqual({
      installationId,
      grantedBy: "user_other_admin",
      grantedAt: expect.any(Date),
    });
    expect(await writeGrants.list(team)).toEqual([regrant]);
    expect((await rows(team)).map((row) => row.event)).toEqual(["granted", "revoked", "granted"]);
  });
});

/** The Team's rows for the installation, by event. */
const eventCounts = async (team: string, installationId: number) => {
  const counts = { granted: 0, revoked: 0 };
  for (const row of await rows(team)) {
    if (Number(row.installation_id) === installationId) counts[row.event] += 1;
  }
  return counts;
};

describe("revoke", () => {
  it("writes a revoked row naming who found the installation gone, and the installation leaves the list", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    const other = newInstallation();
    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
    const kept = await writeGrants.grant(team, { installationId: other, grantedBy: ADMIN });

    expect(await writeGrants.revoke(team, { installationId, revokedBy: "user_member" })).toBe(true);

    expect(await eventCounts(team, installationId)).toEqual({ granted: 1, revoked: 1 });
    expect((await rows(team)).at(-1)).toMatchObject({
      event: "revoked",
      caused_by: "user_member",
      at: expect.any(Date),
    });
    expect(await writeGrants.list(team)).toEqual([kept]);
  });

  it("writes nothing for a second revoke, and a grant after it lists the installation again", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
    await writeGrants.revoke(team, { installationId, revokedBy: "user_member" });

    expect(await writeGrants.revoke(team, { installationId, revokedBy: "user_member" })).toBe(
      false,
    );
    expect(await eventCounts(team, installationId)).toEqual({ granted: 1, revoked: 1 });

    const regrant = await writeGrants.grant(team, { installationId, grantedBy: ADMIN });

    expect(await writeGrants.list(team)).toEqual([regrant]);
    expect(await eventCounts(team, installationId)).toEqual({ granted: 2, revoked: 1 });
  });

  it("writes nothing for an installation the Team never granted", async () => {
    const team = await newTeam(withTeam);

    expect(
      await writeGrants.revoke(team, { installationId: newInstallation(), revokedBy: ADMIN }),
    ).toBe(false);
    expect(await rows(team)).toEqual([]);
  });

  it("writes nothing for Team B's revoke of Team A's installation, and Team A's grant is still listed", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    const grant = await writeGrants.grant(teamA, { installationId, grantedBy: ADMIN });

    expect(await writeGrants.revoke(teamB, { installationId, revokedBy: ADMIN })).toBe(false);

    expect(await rows(teamB)).toEqual([]);
    expect(await eventCounts(teamA, installationId)).toEqual({ granted: 1, revoked: 0 });
    expect(await writeGrants.list(teamA)).toEqual([grant]);
  });

  it("waits on the installation's lock: it writes nothing while another transaction holds it, then finishes", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();
    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
    const key = `github_write_grants:${installationId}`;
    // The holder and the probe get a pool of their own: the store's pool is busy with the waiting revoke.
    const probe = poolAs("warden_app", inject("testDatabase"));
    const holder = await probe.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);

      const revoked = writeGrants.revoke(team, { installationId, revokedBy: "user_member" });
      await queuedBehindLock(probe, key, "the installation's write-grants lock");

      expect(await eventCounts(team, installationId)).toEqual({ granted: 1, revoked: 0 });

      await holder.query("commit");
      expect(await revoked).toBe(true);
    } finally {
      holder.release();
      await probe.end();
    }
    expect(await eventCounts(team, installationId)).toEqual({ granted: 1, revoked: 1 });
  });
});

describe("one Team per installation", () => {
  it.each([
    ["granted", false],
    ["revoked", true],
  ])(
    "refuses Team B's grant of an installation Team A's newest row names as %s with InstallationLinkedElsewhere, writing nothing",
    async (_newest, revoked) => {
      const teamA = await newTeam(withTeam);
      const teamB = await newTeam(withTeam);
      const installationId = newInstallation();
      await writeGrants.grant(teamA, { installationId, grantedBy: ADMIN });
      if (revoked) await insertRow(teamA, { installationId, event: "revoked" });
      const listA = await writeGrants.list(teamA);
      const rowsA = await rows(teamA);

      await expect(
        writeGrants.grant(teamB, { installationId, grantedBy: ADMIN }),
      ).rejects.toBeInstanceOf(InstallationLinkedElsewhere);

      expect(await rows(teamB)).toEqual([]);
      expect(await writeGrants.list(teamB)).toEqual([]);
      expect(await writeGrants.list(teamA)).toEqual(listA);
      expect(await rows(teamA)).toEqual(rowsA);
    },
  );

  it("refuses a row Team B writes straight into the table for an installation Team A's rows name", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    await writeGrants.grant(teamA, { installationId, grantedBy: ADMIN });

    await expect(insertRow(teamB, { installationId, event: "granted" })).rejects.toThrow(
      /github_write_grants_one_team/,
    );

    expect(await rows(teamB)).toEqual([]);
  });
});

describe("Teams apart (ADR 0006)", () => {
  it("shows Team B none of Team A's rows, and refuses Team B's insert naming Team A", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = newInstallation();
    await writeGrants.grant(teamA, { installationId, grantedBy: ADMIN });

    expect(
      await withTeam(teamB, (tx) =>
        tx
          .selectFrom("github_write_grants")
          .selectAll()
          .where("installation_id", "=", String(installationId))
          .execute(),
      ),
    ).toEqual([]);
    await expect(
      insertRow(teamB, { installationId: newInstallation(), event: "granted", teamId: teamA }),
    ).rejects.toThrow(/row-level security/);
    expect(await rows(teamA)).toHaveLength(1);
  });
});

describe("the table's checks", () => {
  it.each<[string, { event: WriteGrantEvent; causedBy?: string; installationId?: number }, RegExp]>(
    [
      // The type allows only the two events, so the case that the table refuses another needs the cast.
      [
        "an event other than granted or revoked",
        { event: "suspended" as WriteGrantEvent },
        /event_check/,
      ],
      ["a blank caused_by", { event: "granted", causedBy: " " }, /caused_by_check/],
      ["an empty caused_by", { event: "granted", causedBy: "" }, /caused_by_check/],
      ["an installation id of 0", { event: "granted", installationId: 0 }, /installation_id_check/],
      [
        "a negative installation id",
        { event: "granted", installationId: -5 },
        /installation_id_check/,
      ],
    ],
  )("refuses %s, and adds no row", async (_name, row, constraint) => {
    const team = await newTeam(withTeam);

    await expect(insertRow(team, { installationId: newInstallation(), ...row })).rejects.toThrow(
      constraint,
    );

    expect(await rows(team)).toEqual([]);
  });
});
