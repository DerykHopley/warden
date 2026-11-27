// A Lead's named decisions on a Finding (ADR 0005), and a Finding's history, as the API takes and answers them. The
// Team and the Actor come from the session, never the body: each body is strict, so naming either is refused.
import { z } from "zod";
import { Actor, DateTime, Id, Severity, Status, Text } from "./finding.ts";

/** A person's named decisions on a Finding: the dashboard's buttons and the reconcile cases' decision steps. */
export const Decision = z.enum([
  "accept",
  "mark_false_positive",
  "confirm_fix",
  "mark_moved",
  "reopen",
]);
export type Decision = z.infer<typeof Decision>;

/**
 * Which Statuses each decision takes: the server refuses any other (409), and the dashboard offers only these. Every
 * decision also refuses a Finding merged into another (`moved_to` set), and confirm_fix and mark_moved one without an
 * Unconfirmed fix.
 */
export const DECISION_TAKES: Readonly<Record<Decision, readonly Status[]>> = {
  accept: ["open", "accepted"],
  mark_false_positive: ["open", "accepted"],
  confirm_fix: ["fixed"],
  mark_moved: ["fixed"],
  reopen: ["false_positive", "accepted"],
};

/** Postgres can't store a NUL in text and would refuse the write as a 500, so a field holding one is a 400. */
export const NUL_MESSAGE = "holds a NUL character, which Warden can't store";
/** The string schema, refusing a NUL with `NUL_MESSAGE`: for a body's field that Postgres stores or reads. */
export const storable = <T extends z.ZodString>(schema: T) =>
  schema.refine((value) => !value.includes("\0"), NUL_MESSAGE);

/** Why a person decided: 1 to 2,000 characters, not only whitespace, and no NUL. */
export const DecisionReason = storable(Text(2000));

/** `POST /api/findings/:id/false-positive`, `confirm-fix`, `reopen` and `POST /api/proposals/:id/reject`: the reason
 * alone. */
export const ReasonBody = z.strictObject({ reason: DecisionReason });
export type ReasonBody = z.infer<typeof ReasonBody>;

/** When an acceptance expires, as a body sends it: later than now. */
const FutureUntil = DateTime.refine((until) => Date.parse(until) > Date.now(), {
  message: "until must be later than now",
});

/** `POST /api/findings/:id/accept`: the reason, and when the acceptance expires, which must be later than now. */
export const AcceptBody = z.strictObject({ reason: DecisionReason, until: FutureUntil });
export type AcceptBody = z.infer<typeof AcceptBody>;

/**
 * `POST /api/findings/:id/mark-moved`: the reason, and the new Finding (one of its candidates) that merges into it.
 * The candidate is an id the store reads, so it holds no NUL either.
 */
export const MarkMovedBody = z.strictObject({ reason: DecisionReason, candidate: storable(Id) });
export type MarkMovedBody = z.infer<typeof MarkMovedBody>;

/** The decisions a Proposal may suggest: only these two are Proposals. */
export const ProposalDecision = z.enum(["accept", "mark_false_positive"]);
export type ProposalDecision = z.infer<typeof ProposalDecision>;

/**
 * `POST /api/findings/:id/proposals`: a suggested decision and its reason, with an `until` exactly on an accept,
 * later than now. Who asks is the session's person, never the body's.
 */
export const ProposeBody = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("accept"), reason: DecisionReason, until: FutureUntil }),
  z.strictObject({ decision: z.literal("mark_false_positive"), reason: DecisionReason }),
]);
export type ProposeBody = z.infer<typeof ProposeBody>;

/** A Proposal waits for a Lead (`pending`), then is decided once and kept as it is. */
export const ProposalState = z.enum(["pending", "approved", "rejected"]);
export type ProposalState = z.infer<typeof ProposalState>;

/**
 * A decision an agent or a Member suggests, which a Lead approves or rejects (ADR 0005, ADR 0008). It keeps who asked
 * and who decided. The answer of the three Proposal routes.
 */
export const Proposal = z.strictObject({
  id: Id,
  finding_id: Id,
  decision: ProposalDecision,
  reason: DecisionReason,
  /** An accept's expiry, as asked; null on mark_false_positive. It may have passed since. */
  until: DateTime.nullable(),
  requested_by: Actor,
  requested_at: DateTime,
  state: ProposalState,
  /** The Lead who approved or rejected it: a Clerk user id. Null while pending. */
  decided_by: Id.nullable(),
  decided_at: DateTime.nullable(),
  /** Why it was rejected; null otherwise. */
  decided_reason: DecisionReason.nullable(),
});
export type Proposal = z.infer<typeof Proposal>;

/**
 * What caused a history entry: a Scan, a Spot run, a person's named decision, or a Job of Warden's own (the daily
 * expiry). Never an agent: it only proposes.
 */
export const HistoryCauseKind = z.enum(["scan", "spot_run", "person", "job"]);
export type HistoryCauseKind = z.infer<typeof HistoryCauseKind>;

/**
 * One change in a Finding's history. Its cause is the Scan or Spot run, the person who decided, or the Job; never an
 * agent. When a person's decision approved a Proposal, `proposal` names it and who asked for it.
 */
export const HistoryEntryBody = z.strictObject({
  at: DateTime,
  /** Null when this entry opened the Finding. */
  status_before: Status.nullable(),
  status_after: Status,
  severity_before: Severity.nullable(),
  severity_after: Severity,
  cause: z.strictObject({ kind: HistoryCauseKind, id: Id }),
  reason: z.string().min(1),
  proposal: z.strictObject({ id: Id, requested_by: Actor }).nullable(),
});
export type HistoryEntryBody = z.infer<typeof HistoryEntryBody>;

/** `GET /api/findings/:id/history`: the Finding's history, oldest first. */
export const HistoryBody = z.object({ history: z.array(HistoryEntryBody) });
export type HistoryBody = z.infer<typeof HistoryBody>;
