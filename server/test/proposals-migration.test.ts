// 0007_one_pending_proposal on data 0006_proposals stored: a Finding with several pending Proposals keeps every one,
// decided by nobody; the later ones are marked `duplicate_of` the earliest (by requested_at, then id), and proposing on
// that Finding waits until a Lead has decided each. A database of its own, migrated to 0006, written as the app wrote
// it then, then migrated to the shipped migrations.
import { randomUUID } from "node:crypto";
import { fingerprint, type Actor, type Finding } from "@warden/contracts";
import type { Selectable } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import type { Database } from "../src/schema.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { refusal, seedTeam } from "./helpers.ts";

const ENV = "guard/agent-can-read-env";
const lead: Actor = { kind: "person", id: "user_lead" };
const member: Actor = { kind: "person", id: "user_member" };
const teamA = `org_upgrade_a_${randomUUID()}`;
const teamB = `org_upgrade_b_${randomUUID()}`;
const WAITING = "This Finding already has a Proposal waiting for a Lead or Admin to decide.";

const EARLY = new Date("2026-11-20T09:00:00Z");
const LATER = new Date("2026-11-20T10:00:00Z");

type Row = Selectable<Database["proposals"]>;

let withTeam: WithTeam;
let owner: pg.Pool;
let end: (() => Promise<void>) | undefined;
let findings: Findings;
/** Each Team's Proposals as 0006 stored them, read before 0007 ran. */
const before: Record<string, Row[]> = {};

const openFinding = (team: string, id: string): Finding => {
  const location = { kind: "file", path: `${id}.json` } as const;
  return {
    id,
    team,
    asset: { kind: "repo", ref: "https://github.com/example/app" },
    module: "guard",
    rule_id: ENV,
    fingerprint: fingerprint(ENV, location),
    location,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
  };
};

/** A pending Proposal as 0006 stored it: a Member's False positive on `findingId`, asked at `at`. */
const asked = (team: string, id: string, findingId: string, at: Date) => ({
  team_id: team,
  id,
  finding_id: findingId,
  decision: "mark_false_positive" as const,
  reason: `Asked as ${id}`,
  accepted_until: null,
  requested_by_kind: "person" as const,
  requested_by_id: member.id,
  requested_at: at,
});

const proposals = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("proposals").selectAll().orderBy("id").execute());

beforeAll(async () => {
  const { pools, withTeamAs, ...made } = await ownDatabase(["warden_app", "warden_migrate"], {
    upTo: "0006_proposals",
    before: async (withTeamAs) => {
      const app = withTeamAs.warden_app;
      for (const team of [teamA, teamB]) {
        await seedTeam(app, team, [
          [lead.id, "lead"],
          [member.id, "member"],
        ]);
      }
      await app(teamA, async (tx) => {
        await tx
          .insertInto("findings")
          .values(["f-three", "f-one", "f-decided"].map((id) => toRow(openFinding(teamA, id))))
          .execute();
        // p-b goes in first, at the same time as p-a: the id breaks the tie, not the order written.
        await tx
          .insertInto("proposals")
          .values([
            asked(teamA, "p-b", "f-three", EARLY),
            asked(teamA, "p-a", "f-three", EARLY),
            asked(teamA, "p-c", "f-three", LATER),
            asked(teamA, "p-one", "f-one", EARLY),
            asked(teamA, "p-decided", "f-decided", EARLY),
          ])
          .execute();
        await tx
          .updateTable("proposals")
          .set({ state: "rejected", decided_by: lead.id, decided_at: LATER, decided_reason: "No" })
          .where("id", "=", "p-decided")
          .execute();
      });
      // Team B has a Finding with the same id and an earlier pending Proposal: another Team's never counts.
      await app(teamB, async (tx) => {
        await tx
          .insertInto("findings")
          .values(toRow(openFinding(teamB, "f-three")))
          .execute();
        await tx
          .insertInto("proposals")
          .values(asked(teamB, "p-b-team", "f-three", new Date("2026-11-19T09:00:00Z")))
          .execute();
      });
      before[teamA] = await app(teamA, (tx) =>
        tx.selectFrom("proposals").selectAll().orderBy("id").execute(),
      );
      before[teamB] = await app(teamB, (tx) =>
        tx.selectFrom("proposals").selectAll().orderBy("id").execute(),
      );
    },
  });
  end = made.end;
  withTeam = withTeamAs.warden_app;
  owner = pools.warden_migrate;
  findings = createFindings({ withTeam, moveRules: {} });
}, 30_000);

afterAll(() => end?.(), 30_000);

/** A row without the column 0007 added: what 0006 stored. */
function as0006(row: Row): Omit<Row, "duplicate_of"> {
  const stored: Partial<Row> = { ...row };
  delete stored.duplicate_of;
  return stored as Omit<Row, "duplicate_of">;
}

describe("0007_one_pending_proposal on a database 0006 wrote", () => {
  it("keeps every Proposal as it was, and marks only the later pending ones on a Finding, pointing at the earliest", async () => {
    const [a, b] = [await proposals(teamA), await proposals(teamB)];

    expect(a.map(as0006)).toEqual(before[teamA]);
    expect(b.map(as0006)).toEqual(before[teamB]);
    expect(Object.fromEntries(a.map((row) => [row.id, row.duplicate_of]))).toEqual({
      "p-a": null,
      "p-b": "p-a",
      "p-c": "p-a",
      "p-decided": null,
      "p-one": null,
    });
    expect(b.map((row) => row.duplicate_of)).toEqual([null]);
  });

  it("leaves proposals with row-level security forced", async () => {
    const { rows } = await owner.query<{ forced: boolean }>(
      "select relforcerowsecurity as forced from pg_class where oid = 'proposals'::regclass",
    );
    expect(rows).toEqual([{ forced: true }]);
  });

  it("refuses a Member's Proposal on the marked Finding until every pending one on it is decided", async () => {
    const ask = () =>
      findings.propose(teamA, "f-three", {
        requester: member,
        decision: "mark_false_positive",
        reason: "Asked after the upgrade",
      });

    for (const id of ["p-a", "p-b"]) {
      expect(await refusal(ask())).toEqual({ name: "ProposalPending", message: WAITING });
      await findings.rejectProposal(teamA, id, { actor: lead, reason: "Asked again later" });
    }
    expect(await refusal(ask())).toEqual({ name: "ProposalPending", message: WAITING });
    await findings.approveProposal(teamA, "p-c", { actor: lead });
    // Deciding a marked one keeps its mark.
    expect(
      (await proposals(teamA))
        .filter((row) => row.finding_id === "f-three")
        .map(({ id, state, duplicate_of }) => ({ id, state, duplicate_of })),
    ).toEqual([
      { id: "p-a", state: "rejected", duplicate_of: null },
      { id: "p-b", state: "rejected", duplicate_of: "p-a" },
      { id: "p-c", state: "approved", duplicate_of: "p-a" },
    ]);

    // p-c's approval made the Finding a False positive, which takes no Proposal: reopen it, as a Lead would.
    await findings.reopen(teamA, "f-three", { actor: lead, reason: "Not a fixture after all" });
    await expect(ask()).resolves.toMatchObject({ finding_id: "f-three", state: "pending" });
  });
});
