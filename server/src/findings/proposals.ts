// Proposals (ADR 0005, ADR 0008): a decision an agent or a Member suggests, kept as a `pending` row until a Lead
// approves it (the decision is then made as that Lead, through applyDecision) or rejects it. Each keeps who asked and
// who decided. Every call runs inside the caller's `withTeam` transaction, under the Team's Findings lock, so a
// Proposal is decided at most once and a refusal writes nothing.
import { randomUUID } from "node:crypto";
import { Proposal, type Actor, type ProposalDecision, type ProposeBody } from "@warden/contracts";
import { sql, type Selectable, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import {
  applyDecision,
  findingFor,
  recheckLead,
  type Decision,
  type DecisionCall,
} from "./decisions.ts";
import { lockTeamFindings } from "./reconcile.ts";
import { isoDateTime } from "./rows.ts";

/** The Proposal id isn't one the Team has: another Team's id counts the same. */
export class ProposalNotFound extends Error {
  readonly proposalId: string;

  constructor(proposalId: string) {
    super(`No Proposal ${proposalId} in this Team`);
    this.name = "ProposalNotFound";
    this.proposalId = proposalId;
  }
}

/** The Proposal was already approved or rejected: it is decided once. Nothing was written. */
export class ProposalDecided extends Error {
  readonly proposalId: string;
  readonly state: Proposal["state"];

  constructor(proposalId: string, state: Proposal["state"]) {
    super(`Proposal ${proposalId} is already ${state}`);
    this.name = "ProposalDecided";
    this.proposalId = proposalId;
    this.state = state;
  }
}

/** The named call each Proposal decision is made with. */
const CALL: Record<ProposalDecision, DecisionCall> = {
  accept: "accept",
  mark_false_positive: "markFalsePositive",
};

type ProposalRow = Selectable<Database["proposals"]>;

/** The Proposal a row holds, parsed with the contracts' Proposal. */
function fromRow(row: ProposalRow): Proposal {
  return Proposal.parse({
    id: row.id,
    finding_id: row.finding_id,
    decision: row.decision,
    reason: row.reason,
    until: row.accepted_until && isoDateTime(row.accepted_until),
    requested_by: { kind: row.requested_by_kind, id: row.requested_by_id },
    requested_at: isoDateTime(row.requested_at),
    state: row.state,
    decided_by: row.decided_by,
    decided_at: row.decided_at && isoDateTime(row.decided_at),
    decided_reason: row.decided_reason,
  });
}

/** Stores a pending Proposal on the Team's Finding `findingId`, when its decision may be made on the Finding now. */
export async function applyPropose(
  tx: Transaction<Database>,
  team: string,
  findingId: string,
  requester: Actor,
  body: ProposeBody,
): Promise<Proposal> {
  await lockTeamFindings(tx, team);
  await findingFor(tx, team, findingId, CALL[body.decision]);
  const row = await tx
    .insertInto("proposals")
    .values({
      team_id: team,
      id: randomUUID(),
      finding_id: findingId,
      decision: body.decision,
      reason: body.reason,
      accepted_until: body.decision === "accept" ? body.until : null,
      requested_by_kind: requester.kind,
      requested_by_id: requester.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return fromRow(row);
}

/** Under the Team's lock, the Lead `person` rechecked, the Team's pending Proposal `id`. */
async function pendingProposal(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
): Promise<ProposalRow> {
  await lockTeamFindings(tx, team);
  await recheckLead(tx, team, person);
  const row = await tx
    .selectFrom("proposals")
    .selectAll()
    .where("team_id", "=", team)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new ProposalNotFound(id);
  if (row.state !== "pending") throw new ProposalDecided(id, row.state);
  return row;
}

/** Marks the pending Proposal decided by `person`, and returns it. */
async function decide(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
  outcome:
    { state: "approved"; decided_reason: null } | { state: "rejected"; decided_reason: string },
): Promise<Proposal> {
  const row = await tx
    .updateTable("proposals")
    .set({ ...outcome, decided_by: person, decided_at: sql<Date>`now()` })
    .where("team_id", "=", team)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return fromRow(row);
}

/**
 * Approves the Team's pending Proposal `id` as the Lead `person`: its decision is made through applyDecision as that
 * person, with the Proposal's reason and until, and its history rows name the Proposal.
 */
export async function applyApprove(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
): Promise<Proposal> {
  const proposal = await pendingProposal(tx, team, id, person);
  const decision: Decision =
    proposal.decision === "accept"
      ? { call: "accept", reason: proposal.reason, until: proposal.accepted_until!.toISOString() }
      : { call: "markFalsePositive", reason: proposal.reason };
  await applyDecision(tx, team, proposal.finding_id, person, decision, proposal.id);
  return decide(tx, team, id, person, { state: "approved", decided_reason: null });
}

/** Rejects the Team's pending Proposal `id` as the Lead `person`, with their reason. The Finding doesn't change. */
export async function applyReject(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
  reason: string,
): Promise<Proposal> {
  await pendingProposal(tx, team, id, person);
  return decide(tx, team, id, person, { state: "rejected", decided_reason: reason });
}
