// The Team's pending Proposals as the server lists them (`GET /api/proposals`), for the detail card.
import { ProposalsBody, type PendingProposal } from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

export type ProposalsResult =
  /** The pending Proposals of `team`, the Team the server answered about, oldest first. */
  | { kind: "proposals"; team: string; proposals: PendingProposal[] }
  /** 403: the session has no Team (its active Organization went away). */
  | { kind: "no-team" }
  /** 409: the Team's Admin hasn't opened Warden yet. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchProposals(getToken: GetToken): Promise<ProposalsResult> {
  const res = await callWarden(getToken, "/api/proposals");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, ProposalsBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "proposals", ...body };
}
