// Story 8: a Finding's history can't be edited, by the app or by the tables' owner (threat D6). warden_app has no
// update, delete or truncate grant on it, so Postgres refuses those first; the owner, warden_migrate, has every grant,
// and the append-only trigger refuses it. It runs on a database of its own: the owner's truncate locks the table
// against every other file writing history on the suite's shared database.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HistoryActorKind } from "../src/schema.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";

const team = `org_history_${randomUUID()}`;
let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
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
}, 30_000);

afterAll(() => end?.(), 30_000);

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

// 0005_person_decisions: a person's named decision is history too (ADR 0005); an agent only proposes, so never.
describe("finding_history's actor_kind", () => {
  const historyRow = (actor_kind: string, actor_id: string) =>
    withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("finding_history")
        .values({
          team_id: team,
          finding_id: "f-1",
          status_before: "open",
          status_after: "false_positive",
          severity_before: "high",
          severity_after: "high",
          actor_kind: actor_kind as HistoryActorKind,
          actor_id,
          reason: "The file is a test fixture",
        })
        .execute(),
    );

  it("takes a person", async () => {
    await historyRow("person", "user_lead");

    expect((await rows()).at(-1)).toMatchObject({ actor_kind: "person", actor_id: "user_lead" });
  });

  it("refuses an agent, and adds no row", async () => {
    const before = await rows();

    await expect(historyRow("agent", "agent-1")).rejects.toThrow(
      /finding_history_actor_kind_check/,
    );

    expect(await rows()).toEqual(before);
  });

  // 0006_proposals: the daily Job reopens an expired acceptance.
  it("takes the daily Job", async () => {
    await historyRow("job", "daily-expiry");

    expect((await rows()).at(-1)).toMatchObject({ actor_kind: "job", actor_id: "daily-expiry" });
  });
});

// 0006_proposals: a person's decision that approved a Proposal names it; nothing else may.
describe("finding_history's proposal_id", () => {
  beforeAll(async () => {
    await withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("proposals")
        .values({
          team_id: team,
          id: "p-1",
          finding_id: "f-1",
          decision: "mark_false_positive",
          reason: "A test fixture",
          accepted_until: null,
          requested_by_kind: "agent",
          requested_by_id: "guard-bot",
        })
        .execute(),
    );
  });

  const withProposal = (actor_kind: HistoryActorKind, actor_id: string) =>
    withTeamAs.warden_app(team, (tx) =>
      tx
        .insertInto("finding_history")
        .values({
          team_id: team,
          finding_id: "f-1",
          status_before: "open",
          status_after: "false_positive",
          severity_before: "high",
          severity_after: "high",
          actor_kind,
          actor_id,
          reason: "A test fixture",
          proposal_id: "p-1",
        })
        .execute(),
    );

  it.each([
    ["job", "daily-expiry"],
    ["scan", "scan-9"],
    ["spot_run", "spot-9"],
  ] as const)("refuses it on a %s row, and adds no row", async (kind, id) => {
    const before = await rows();

    await expect(withProposal(kind, id)).rejects.toThrow(/finding_history_proposal_check/);

    expect(await rows()).toEqual(before);
  });

  it("takes it on a person's row", async () => {
    await withProposal("person", "user_lead");

    expect((await rows()).at(-1)).toMatchObject({ actor_kind: "person", proposal_id: "p-1" });
  });

  it("refuses a Proposal the Team doesn't have", async () => {
    await expect(
      withTeamAs.warden_app(team, (tx) =>
        tx
          .insertInto("finding_history")
          .values({
            team_id: team,
            finding_id: "f-1",
            status_before: "open",
            status_after: "false_positive",
            severity_before: "high",
            severity_after: "high",
            actor_kind: "person",
            actor_id: "user_lead",
            reason: "r",
            proposal_id: "p-nowhere",
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
