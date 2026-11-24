// What the detail card sends (story 4, ADR 0005): a Lead's named decisions on a Finding, a Member's Proposal, and a
// Lead's approval or rejection of one. Which of them a Finding's Status offers, each call and its answers, and the
// Until a person picks, sent as the end of that day in their own time zone. The server checks the Role on every call
// (ADR 0008): the card only hides what a Role can't do.
import {
  Decision,
  DECISION_TAKES,
  Finding,
  Proposal,
  type AcceptBody,
  type MarkMovedBody,
  type ProposalDecision,
  type ProposeBody,
  type ReasonBody,
} from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

/**
 * The decisions a Lead may take on `finding` now, in the card's order: the Status rule the server checks (the
 * contracts' DECISION_TAKES). A Finding merged into another takes none; confirm fix and mark moved need an Unconfirmed
 * fix.
 */
export function decisionsFor(finding: Finding): Decision[] {
  if (finding.moved_to !== null) return [];
  return Decision.options.filter(
    (decision) =>
      DECISION_TAKES[decision].includes(finding.status) &&
      ((decision !== "confirm_fix" && decision !== "mark_moved") ||
        finding.unconfirmed_fix !== null),
  );
}

/** The Proposals a Member may make on `finding` now: the decisions a Proposal may hold that its Status allows. */
export function proposalsFor(finding: Finding): ProposalDecision[] {
  return decisionsFor(finding).filter(
    (decision): decision is ProposalDecision =>
      decision === "accept" || decision === "mark_false_positive",
  );
}

/** A 404 on a decision or a Proposal of one: the card says it, and the Findings page too, past the card. */
export const FINDING_GONE = "This Finding is no longer in your Team.";

/** A call's answer: what the server answered on success, or why it refused. */
export type ActionResult<T> =
  | { kind: "done"; answer: T }
  /** 400: the body failed its schema; `error` is the server's list of fields. */
  | { kind: "invalid"; error: string }
  /** 403: the person's Role is too low (or was lowered mid-call), or they have no Team. */
  | { kind: "forbidden" }
  /** 404: the Team has no Finding or Proposal with that id. */
  | { kind: "not-found" }
  /**
   * 409: the Finding's Status doesn't take it, the Proposal was decided already or is stale, or the Team's Admin
   * hasn't opened Warden; `error` is the server's words for which, null when its body has none.
   */
  | { kind: "conflict"; error: string | null }
  | Refused;

/** A refusal's `error`: the server's words for it, or null when its body has none. */
async function serverError(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  const error =
    typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim() !== "" ? error : null;
}

/**
 * The candidates Mark moved may merge into `finding`, as the server checks them: Open, not merged into another, and
 * with the Finding's own module, Rule and Asset.
 */
export const mergeableCandidates = (finding: Finding, candidates: readonly Finding[]) =>
  candidates.filter(
    (candidate) =>
      candidate.status === "open" &&
      candidate.moved_to === null &&
      candidate.module === finding.module &&
      candidate.rule_id === finding.rule_id &&
      candidate.asset.kind === finding.asset.kind &&
      candidate.asset.ref === finding.asset.ref,
  );

/** POSTs `body` (none when undefined) to `path`; a success whose body doesn't parse by `schema` is not answering. */
async function post<T>(
  getToken: GetToken,
  path: string,
  body: unknown,
  schema: Parameters<typeof parsed<T>>[1],
): Promise<ActionResult<T>> {
  const res = await callWarden(getToken, path, { method: "POST", body });
  if (!(res instanceof Response)) return res;
  switch (res.status) {
    case 400:
      return { kind: "invalid", error: (await serverError(res)) ?? "the request" };
    case 403:
      return { kind: "forbidden" };
    case 404:
      return { kind: "not-found" };
    case 409:
      return { kind: "conflict", error: await serverError(res) };
  }
  const answer = await parsed(res, schema);
  return answer === undefined ? { kind: "not-answering" } : { kind: "done", answer };
}

const DECISION_PATHS: Record<Decision, string> = {
  accept: "accept",
  mark_false_positive: "false-positive",
  confirm_fix: "confirm-fix",
  mark_moved: "mark-moved",
  reopen: "reopen",
};

/** A decision and its body, typed by the contracts schema its route parses. */
export type DecisionRequest =
  | { decision: "accept"; body: AcceptBody }
  | { decision: "mark_moved"; body: MarkMovedBody }
  | { decision: "mark_false_positive" | "confirm_fix" | "reopen"; body: ReasonBody };

const findingPath = (id: string) => `/api/findings/${encodeURIComponent(id)}`;
const proposalPath = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;

/** A Lead's decision on the Finding `id`: answers the Finding as changed (mark moved: the old one, now Open). */
export const decide = (getToken: GetToken, id: string, { decision, body }: DecisionRequest) =>
  post(getToken, `${findingPath(id)}/${DECISION_PATHS[decision]}`, body, Finding);

/** A Member's (or anyone's) Proposal on the Finding `id`: answers the Proposal, pending. */
export const propose = (getToken: GetToken, id: string, body: ProposeBody) =>
  post(getToken, `${findingPath(id)}/proposals`, body, Proposal);

/** A Lead approves the Proposal `id`, with no body: it holds its reason and until. */
export const approveProposal = (getToken: GetToken, id: string) =>
  post(getToken, `${proposalPath(id)}/approve`, undefined, Proposal);

/** A Lead rejects the Proposal `id`, with a reason. */
export const rejectProposal = (getToken: GetToken, id: string, body: ReasonBody) =>
  post(getToken, `${proposalPath(id)}/reject`, body, Proposal);

const twoDigits = (n: number) => String(n).padStart(2, "0");

/** A day as a date input holds it: "2026-12-01", in the person's own time zone. */
const dateInputValue = (date: Date) =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;

/** The earliest Until a person may pick: the day after `now`'s day, in their own time zone. */
export function earliestUntil(now = new Date()): string {
  return dateInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

/**
 * The end of `day` (a date input's value) in the person's own time zone, as an ISO date-time with that day's offset:
 * "2026-12-01T23:59:59.999-05:00".
 */
export function endOfDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const end = new Date(year, month - 1, date, 23, 59, 59, 999);
  // getTimezoneOffset is minutes behind UTC: New York's -05:00 is +300.
  const ahead = -end.getTimezoneOffset();
  const sign = ahead < 0 ? "-" : "+";
  const offset = `${sign}${twoDigits(Math.floor(Math.abs(ahead) / 60))}:${twoDigits(Math.abs(ahead) % 60)}`;
  return `${day}T23:59:59.999${offset}`;
}
