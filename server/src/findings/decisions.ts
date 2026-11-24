// A person's named decisions on a Finding (ADR 0005): accept, mark a False positive, confirm a fix, mark one moved,
// reopen. Each runs inside one `withTeam` transaction under the same per-Team lock as reconcile, rechecks there that
// the person is still a Lead, and writes one history row per changed Finding naming the person and their reason. An
// agent never decides: it only proposes.
import {
  AcceptBody,
  Actor,
  atLeast,
  MarkMovedBody,
  ReasonBody,
  type Finding,
  type Status,
} from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import type { Database } from "../schema.ts";
import { lockTeamFindings, writtenAt } from "./reconcile.ts";
import { fromRow, loadFinding, sameAsset, toRow } from "./rows.ts";

/** Each named call, as `Findings` names it, and the contracts schema its input is checked against (the API's too). */
export const DECISION_INPUT = {
  accept: AcceptBody,
  markFalsePositive: ReasonBody,
  confirmFix: ReasonBody,
  markMoved: MarkMovedBody,
  reopen: ReasonBody,
} as const;

export type DecisionCall = keyof typeof DECISION_INPUT;

/** What a named call takes besides its Actor. */
export type DecisionInput<C extends DecisionCall> = z.infer<(typeof DECISION_INPUT)[C]>;

/** A decision's call and what it needs, already checked. */
export type Decision = { [C in DecisionCall]: { call: C } & DecisionInput<C> }[DecisionCall];

/** The Finding id isn't one the Team has: another Team's id counts the same. */
export class FindingNotFound extends Error {
  readonly findingId: string;

  constructor(findingId: string) {
    super(`No Finding ${findingId} in this Team`);
    this.name = "FindingNotFound";
    this.findingId = findingId;
  }
}

/** The call isn't allowed on the Finding as it is now. Nothing was written. */
export class DecisionRefused extends Error {
  readonly call: DecisionCall;
  readonly status: Status;

  constructor(call: DecisionCall, status: Status, why: string) {
    super(`${call} refused: the Finding is ${status}, and ${why}`);
    this.name = "DecisionRefused";
    this.call = call;
    this.status = status;
  }
}

/**
 * Under the Team's lock, the person isn't a Lead or Admin in the Team (any more): a Role change may have committed
 * while the decision waited. Nothing was written.
 */
export class NotALead extends Error {
  readonly person: string;

  constructor(person: string) {
    super(`${person} isn't a Lead in this Team`);
    this.name = "NotALead";
    this.person = person;
  }
}

/** The person an Actor names. An agent throws, before anything is read: it only proposes. */
export function personOf(actor: Actor): string {
  const checked = Actor.parse(actor);
  if (checked.kind !== "person") {
    throw new Error("a decision needs a person: an agent only proposes (ADR 0005)");
  }
  return checked.id;
}

/** Which Statuses each call takes. Every call refuses a Finding merged into another. */
const ALLOWED_FROM: Record<DecisionCall, readonly Status[]> = {
  accept: ["open", "accepted"],
  markFalsePositive: ["open", "accepted"],
  confirmFix: ["fixed"],
  markMoved: ["fixed"],
  reopen: ["false_positive", "accepted"],
};

export const notAccepted = { accepted_reason: null, accepted_until: null } as const;

/**
 * Under the Team's lock (the caller holds it), throws NotALead unless `person` is a Lead or Admin in the Team now.
 * requireRole read the Role before the lock; a change that committed since may have taken it. `for share` holds the
 * row, so a Role change waits for the caller's transaction rather than slipping in after the check.
 */
export async function recheckLead(tx: Transaction<Database>, team: string, person: string) {
  const member = await tx
    .selectFrom("team_members")
    .select("role")
    .where("team_id", "=", team)
    .where("user_id", "=", person)
    .forShare()
    .executeTakeFirst();
  if (!member || !atLeast(member.role, "lead")) throw new NotALead(person);
}

/**
 * The Team's Finding `id`, when `call` may be made on it as it is now, and how to refuse `call` on it for any other
 * reason: FindingNotFound for an id the Team doesn't have, DecisionRefused for a merged Finding or a Status the call
 * doesn't take. The same rules for a decision and for a Proposal of one.
 */
export async function findingFor(
  tx: Transaction<Database>,
  team: string,
  id: string,
  call: DecisionCall,
): Promise<{ finding: Finding; refuse: (why: string) => DecisionRefused }> {
  const finding = await loadFinding(tx, team, id);
  if (!finding) throw new FindingNotFound(id);
  const refuse = (why: string) => new DecisionRefused(call, finding.status, why);
  if (finding.moved_to !== null) throw refuse(`it is merged into ${finding.moved_to}`);
  const allowed = ALLOWED_FROM[call];
  if (!allowed.includes(finding.status)) {
    throw refuse(`${call} takes a Finding that is ${allowed.join(" or ")}`);
  }
  return { finding, refuse };
}

/** Applies one decision by `person` to the Team's Finding `id`, and returns it as changed (markMoved: the old one). */
export async function applyDecision(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
  decision: Decision,
): Promise<Finding> {
  await lockTeamFindings(tx, team);
  await recheckLead(tx, team, person);
  return applyLockedDecision(tx, team, id, person, decision);
}

/**
 * The Team's history rows (`h`) written on a Proposal's (`asked`) Finding after it was asked: any one makes that
 * Proposal stale. Approving refuses a stale Proposal and the pending list marks it, both through this one query, so
 * the two can't disagree. Compared in Postgres, at its microseconds: a JavaScript Date would round `requested_at` to
 * the millisecond. Both times are written at `writtenAt`, so in the Team lock's order.
 */
export function changesSinceAsked(tx: Transaction<Database>, team: string) {
  return tx
    .selectFrom("finding_history as h")
    .innerJoin("proposals as asked", (join) =>
      join.onRef("asked.team_id", "=", "h.team_id").onRef("asked.finding_id", "=", "h.finding_id"),
    )
    .where("h.team_id", "=", team)
    .whereRef("h.at", ">", "asked.requested_at");
}

/**
 * applyDecision's work, for a caller that already holds the Team's lock and has rechecked the Lead. With `proposal`,
 * the decision approves that Proposal: it is refused when the Finding has changed since the Proposal was asked (a
 * history row after its `requested_at`, both written at `writtenAt`, so in the Team lock's order), and each history
 * row it writes names the Proposal.
 */
export async function applyLockedDecision(
  tx: Transaction<Database>,
  team: string,
  id: string,
  person: string,
  decision: Decision,
  proposal?: { id: string },
): Promise<Finding> {
  const { finding, refuse } = await findingFor(tx, team, id, decision.call);
  if (proposal) {
    const later = await changesSinceAsked(tx, team)
      .select("h.at")
      .where("asked.id", "=", proposal.id)
      .orderBy("h.id")
      .executeTakeFirst();
    if (later) {
      throw refuse(
        `it changed since the Proposal was asked (at ${later.at.toISOString()}): ask again`,
      );
    }
  }

  /** The Findings to write, in order: markMoved frees the candidate's Fingerprint before the old Finding takes it. */
  const changes: { before: Finding; after: Finding }[] = [];
  /** Other Findings whose Unconfirmed fix named a candidate merged away: no Status changes, so no history row. */
  const untouchedStatus: Finding[] = [];
  switch (decision.call) {
    case "accept":
      // Checked when the input was parsed; a Proposal's until may have passed since it was asked.
      if (Date.parse(decision.until) <= Date.now()) {
        throw refuse(`its until (${decision.until}) has passed`);
      }
      changes.push({
        before: finding,
        after: {
          ...finding,
          status: "accepted",
          accepted_reason: decision.reason,
          accepted_until: decision.until,
        },
      });
      break;
    case "markFalsePositive":
      changes.push({
        before: finding,
        after: { ...finding, status: "false_positive", ...notAccepted },
      });
      break;
    case "reopen":
      changes.push({ before: finding, after: { ...finding, status: "open", ...notAccepted } });
      break;
    case "confirmFix":
      if (finding.unconfirmed_fix === null) throw refuse("it has no Unconfirmed fix to confirm");
      changes.push({ before: finding, after: { ...finding, unconfirmed_fix: null } });
      break;
    case "markMoved": {
      if (finding.unconfirmed_fix === null) throw refuse("it has no Unconfirmed fix to move");
      if (!finding.unconfirmed_fix.candidates.includes(decision.candidate)) {
        throw refuse(`${decision.candidate} isn't one of its candidates`);
      }
      const candidate = await loadFinding(tx, team, decision.candidate);
      if (!candidate || candidate.status !== "open" || candidate.moved_to !== null) {
        const state = !candidate
          ? "gone"
          : candidate.moved_to !== null
            ? `merged into ${candidate.moved_to}`
            : candidate.status;
        throw refuse(`its candidate ${decision.candidate} is ${state}, not open`);
      }
      // The old Finding keeps its module, Rule and Asset, so it can only take a problem with the same three.
      const differs = [
        candidate.module !== finding.module && "module",
        candidate.rule_id !== finding.rule_id && "Rule",
        !sameAsset(candidate.asset, finding.asset) && "Asset",
      ].filter(Boolean);
      if (differs.length > 0) {
        throw refuse(`its candidate ${decision.candidate} has another ${differs.join(" and ")}`);
      }
      changes.push({
        before: candidate,
        after: { ...candidate, status: "fixed", moved_to: finding.id },
      });
      changes.push({
        before: finding,
        after: {
          ...finding,
          status: "open",
          unconfirmed_fix: null,
          location: candidate.location,
          fingerprint: candidate.fingerprint,
          title: candidate.title,
          evidence: candidate.evidence,
          severity: candidate.severity,
          last_seen_scan: candidate.last_seen_scan,
        },
      });
      // The candidate is merged now: no other Finding's Unconfirmed fix may still offer it.
      const naming = await tx
        .selectFrom("findings")
        .selectAll()
        .where("team_id", "=", team)
        .where("id", "<>", finding.id)
        .where(
          sql<boolean>`unconfirmed_fix -> 'candidates' @> ${JSON.stringify([candidate.id])}::jsonb`,
        )
        .execute();
      for (const other of naming.map(fromRow)) {
        const rest = other.unconfirmed_fix!.candidates.filter((c) => c !== candidate.id);
        untouchedStatus.push({
          ...other,
          unconfirmed_fix: rest.length > 0 ? { candidates: rest } : null,
        });
      }
      break;
    }
  }

  for (const after of [...changes.map((change) => change.after), ...untouchedStatus]) {
    const { team_id, id: changedId, ...fields } = toRow(after);
    await tx
      .updateTable("findings")
      .set(fields)
      .where("team_id", "=", team_id)
      .where("id", "=", changedId)
      .execute();
  }
  await tx
    .insertInto("finding_history")
    .values(
      changes.map(({ before, after }) => ({
        team_id: team,
        finding_id: after.id,
        at: writtenAt,
        status_before: before.status,
        status_after: after.status,
        severity_before: before.severity,
        severity_after: after.severity,
        actor_kind: "person" as const,
        actor_id: person,
        reason: decision.reason,
        proposal_id: proposal?.id ?? null,
      })),
    )
    .execute();
  return (await loadFinding(tx, team, id))!;
}
