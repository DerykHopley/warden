// The Findings page: `GET /api/findings`'s answer, and the page's view state as its URL carries it
// (`/findings?status=fixed&severity=high&module=patch&finding=<id>`).
import { z } from "zod";
import { Proposal } from "./decisions.ts";
import { Finding, Id, Module, Severity, Status } from "./finding.ts";

/**
 * `GET /api/findings`: every Finding of the session's Team, and that Team's id, so the page can tell an answer about a
 * Team the person just switched away from. The page filters them; the server doesn't.
 */
export const FindingsBody = z.object({ team: Id, findings: z.array(Finding) });
export type FindingsBody = z.infer<typeof FindingsBody>;

/**
 * A pending Proposal, and whether it is stale: its Finding has changed since it was asked (a history row later than
 * its `requested_at`), so approving it would be refused with 409. It can still be rejected.
 */
export const PendingProposal = Proposal.extend({ stale: z.boolean() });
export type PendingProposal = z.infer<typeof PendingProposal>;

/**
 * `GET /api/proposals`: the session's Team's pending Proposals, oldest first, and that Team's id, as in
 * `FindingsBody`. Approved and rejected Proposals aren't listed.
 */
export const ProposalsBody = z.object({ team: Id, proposals: z.array(PendingProposal) });
export type ProposalsBody = z.infer<typeof ProposalsBody>;

const ALL = "all";

/** Each field's value when the URL doesn't name one, or names one this field doesn't know. */
export const FINDINGS_VIEW_DEFAULTS = { status: "open", severity: ALL, module: ALL } as const;

/**
 * The Findings page's view: which Status, Severity and module the table shows (each one value, or `all`), and the
 * focused Finding's id. Parse a URL query's fields with it (`Object.fromEntries(searchParams)`): a field missing, or
 * holding a value it doesn't know, takes its default, and the other fields keep theirs. Values are the contracts' own
 * enum values, in lower case.
 */
export const FindingsView = z.object({
  status: z.enum([...Status.options, ALL]).catch(FINDINGS_VIEW_DEFAULTS.status),
  severity: z.enum([...Severity.options, ALL]).catch(FINDINGS_VIEW_DEFAULTS.severity),
  module: z.enum([...Module.options, ALL]).catch(FINDINGS_VIEW_DEFAULTS.module),
  finding: Id.optional().catch(undefined),
});
export type FindingsView = z.infer<typeof FindingsView>;

/** The page path for `view`: only the fields that differ from their defaults, in the order status, severity, module,
 * finding. Parsing its query with `FindingsView` gives `view` back. */
export function findingsViewPath(view: FindingsView): string {
  const query = new URLSearchParams();
  for (const field of ["status", "severity", "module"] as const) {
    if (view[field] !== FINDINGS_VIEW_DEFAULTS[field]) query.set(field, view[field]);
  }
  if (view.finding !== undefined) query.set("finding", view.finding);
  const search = query.toString();
  return search === "" ? "/findings" : `/findings?${search}`;
}
