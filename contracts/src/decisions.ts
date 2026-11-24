// A Lead's named decisions on a Finding (ADR 0005), and a Finding's history, as the API takes and answers them. The
// Team and the Actor come from the session, never the body: each body is strict, so naming either is refused.
import { z } from "zod";
import { DateTime, Id, Severity, Status, Text } from "./finding.ts";

/** Why a person decided: 1 to 2,000 characters, not only whitespace. */
export const DecisionReason = Text(2000);

/** `POST /api/findings/:id/false-positive`, `confirm-fix` and `reopen`: the reason alone. */
export const ReasonBody = z.strictObject({ reason: DecisionReason });
export type ReasonBody = z.infer<typeof ReasonBody>;

/** `POST /api/findings/:id/accept`: the reason, and when the acceptance expires, which must be later than now. */
export const AcceptBody = z.strictObject({
  reason: DecisionReason,
  until: DateTime.refine((until) => Date.parse(until) > Date.now(), {
    message: "until must be later than now",
  }),
});
export type AcceptBody = z.infer<typeof AcceptBody>;

/** `POST /api/findings/:id/mark-moved`: the reason, and the new Finding (one of its candidates) that merges into it. */
export const MarkMovedBody = z.strictObject({ reason: DecisionReason, candidate: Id });
export type MarkMovedBody = z.infer<typeof MarkMovedBody>;

/** What caused a history entry: a Scan, a Spot run, or a person's named decision. Never an agent: it only proposes. */
export const HistoryCauseKind = z.enum(["scan", "spot_run", "person"]);
export type HistoryCauseKind = z.infer<typeof HistoryCauseKind>;

/** One change in a Finding's history. Its cause is the Scan or Spot run, or the person who decided; never an agent. */
export const HistoryEntryBody = z.strictObject({
  at: DateTime,
  /** Null when this entry opened the Finding. */
  status_before: Status.nullable(),
  status_after: Status,
  severity_before: Severity.nullable(),
  severity_after: Severity,
  cause: z.strictObject({ kind: HistoryCauseKind, id: Id }),
  reason: z.string().min(1),
});
export type HistoryEntryBody = z.infer<typeof HistoryEntryBody>;

/** `GET /api/findings/:id/history`: the Finding's history, oldest first. */
export const HistoryBody = z.object({ history: z.array(HistoryEntryBody) });
export type HistoryBody = z.infer<typeof HistoryBody>;
