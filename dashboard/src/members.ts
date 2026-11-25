// The Team's people as Warden stores them, and an Admin giving one of them a Role.
import { MembersBody, TeamMember, type Role } from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

export type MembersResult =
  | { kind: "members"; members: TeamMember[] }
  /** 403: the session has no Team (its active Organization went away). */
  | { kind: "no-team" }
  /** 409: the Team's Admin hasn't opened Warden yet. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchMembers(getToken: GetToken): Promise<MembersResult> {
  const res = await callWarden(getToken, "/api/team/members");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, MembersBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "members", ...body };
}

export type RoleChangeResult =
  | { kind: "changed"; member: TeamMember }
  /** 403: the person asking isn't an Admin (any more). */
  | { kind: "not-admin" }
  /** 409: the change would leave the Team with no Admin. */
  | { kind: "last-admin" }
  /** 502: Clerk didn't take the change, so Warden changed nothing. */
  | { kind: "clerk-unreachable" }
  /** 404: the person is no longer in the Team. */
  | { kind: "no-such-member" }
  | Refused;

export async function changeMemberRole(
  getToken: GetToken,
  userId: string,
  role: Role,
): Promise<RoleChangeResult> {
  const res = await callWarden(getToken, `/api/team/members/${encodeURIComponent(userId)}/role`, {
    method: "PUT",
    body: { role },
  });
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "not-admin" };
  if (res.status === 409) return { kind: "last-admin" };
  if (res.status === 502) return { kind: "clerk-unreachable" };
  if (res.status === 404) return { kind: "no-such-member" };
  const member = await parsed(res, TeamMember);
  return member === undefined ? { kind: "not-answering" } : { kind: "changed", member };
}
