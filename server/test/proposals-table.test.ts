// A Proposal is decided once and then kept as it is (0006_proposals, ADR 0008): Postgres refuses an update to a decided
// Proposal, a change to a pending one's own fields, and every delete and truncate, for warden_app and for the tables'
// owner, warden_migrate. warden_app has no delete or truncate grant, so Postgres refuses those first; the triggers
// refuse the rest. Deciding a pending one (its state and decided_* columns) is the one update allowed.
// A Finding takes one unmarked pending Proposal (0007_one_pending_proposal): the partial unique index refuses a second,
// and only that migration sets `duplicate_of`, on the pending ones from before the rule. The database is migrated to
// 0006 first, with three pending Proposals on one Finding, so 0007 marks two of them.
// It runs on a database of its own: the owner's truncate takes a lock on proposals and, through finding_history's
// foreign key, on finding_history too, which deadlocks another file writing history on the suite's shared database.
import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";

const team = `org_proposals_${randomUUID()}`;
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

/** Each test's Proposals sit on a Finding of their own, as a Finding takes one pending Proposal at a time. */
const FINDINGS = ["f-1", "f-2", "f-once", "f-half", "f-dup", "f-free"];

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

/** A pending Proposal to mark `findingId` a False positive, written as warden_app. */
const pending = (id: string, findingId: string, at?: Date) =>
  withTeamAs.warden_app(team, (tx) =>
    tx
      .insertInto("proposals")
      .values({
        team_id: team,
        id,
        finding_id: findingId,
        decision: "mark_false_positive",
        reason: "A test fixture",
        accepted_until: null,
        requested_by_kind: "agent",
        requested_by_id: "guard-bot",
        ...(at && { requested_at: at }),
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
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"], {
    upTo: "0006_proposals",
    before: async (asRole) => {
      withTeamAs = asRole;
      await withTeamAs.warden_app(team, async (tx) => {
        await tx.insertInto("teams").values({ id: team }).execute();
        await tx.insertInto("findings").values(FINDINGS.map(finding)).execute();
      });
      // Before the rule: three pending on one Finding. 0007 marks the later two.
      await pending("p-dup-first", "f-dup", new Date("2026-11-20T09:00:00Z"));
      await pending("p-dup-second", "f-dup", new Date("2026-11-20T10:00:00Z"));
      await pending("p-dup-third", "f-dup", new Date("2026-11-20T11:00:00Z"));
    },
  }));
  await pending("p-pending", "f-1");
  await pending("p-decided", "f-2");
  await decide("p-decided");
}, 30_000);

afterAll(() => end?.(), 30_000);

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
  "a change to a pending Proposal's duplicate_of": {
    statement: sql`update proposals set duplicate_of = 'p-decided' where id = 'p-pending'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "a change to a decided Proposal's duplicate_of": {
    statement: sql`update proposals set duplicate_of = 'p-pending' where id = 'p-decided'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "a marked duplicate's duplicate_of cleared": {
    statement: sql`update proposals set duplicate_of = null where id = 'p-dup-third'`,
    app: /a Proposal is decided once/,
    owner: /a Proposal is decided once/,
  },
  "an insert with duplicate_of set": {
    statement: sql`insert into proposals (team_id, id, finding_id, decision, reason, requested_by_kind,
                   requested_by_id, duplicate_of)
                   values (${team}, 'p-marked', 'f-free', 'mark_false_positive', 'r', 'agent', 'guard-bot',
                   'p-pending')`,
    app: /only 0007_one_pending_proposal marks a Proposal a duplicate/,
    owner: /only 0007_one_pending_proposal marks a Proposal a duplicate/,
  },
  "a second pending Proposal on one Finding, past the server's check": {
    statement: sql`insert into proposals (team_id, id, finding_id, decision, reason, requested_by_kind,
                   requested_by_id)
                   values (${team}, 'p-second', 'f-1', 'mark_false_positive', 'r', 'agent', 'guard-bot')`,
    app: /proposals_one_pending/,
    owner: /proposals_one_pending/,
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
    expect(before).toHaveLength(5);

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
    await pending("p-once", "f-once");

    await decide("p-once");

    const decided = (await rows()).find((row) => row.id === "p-once");
    expect(decided).toMatchObject({ state: "approved", decided_by: "user_lead" });
    await expect(decide("p-once")).rejects.toThrow(/a Proposal is decided once/);
  });

  it("refuses a decided state without decided_by, and decided_by on a pending one", async () => {
    await pending("p-half", "f-half");
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
