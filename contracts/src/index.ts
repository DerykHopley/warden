// The shared contracts: the API bodies the server sends and the dashboard reads, and Finding v1 with what a module
// hands over. One zod schema gives both the type and the check. The dashboard bundles this entry point, so nothing
// here may touch the file system; the reconcile cases load from `@warden/contracts/reconcile-cases`.
import { z } from "zod";

export * from "./finding.ts";
export { fingerprint } from "./fingerprint.ts";
export { agentEventsHash } from "./agent-events-hash.ts";
export * from "./reconcile-case.ts";

/** `GET /api/health`: 200 when every part is ok, 503 naming the part that failed. */
export const HealthBody = z.object({
  status: z.enum(["ok", "unavailable"]),
  database: z.enum(["ok", "unreachable"]),
  /** Whether Postgres lists the `vector` extension as available; `unknown` when the database can't be reached. */
  vector: z.enum(["available", "missing", "unknown"]),
});
export type HealthBody = z.infer<typeof HealthBody>;

/** A person's Role in one Team (ADR 0008), lowest first. Each includes the one before it: a Lead can do what a
 * Member can. */
export const Role = z.enum(["member", "lead", "admin"]);
export type Role = z.infer<typeof Role>;

/** Whether a person with Role `has` may do what needs Role `needed`. The order is `Role`'s, and lives only there. */
export function atLeast(has: Role, needed: Role): boolean {
  return Role.options.indexOf(has) >= Role.options.indexOf(needed);
}

/**
 * `GET /api/me`: the signed-in person, as the server read them from their Clerk session token, with their Team (the
 * token's active Clerk Organization id) and their Role in it from Warden's own table. Both are null when the token
 * has no active Organization.
 */
export const MeBody = z.object({
  userId: z.string().min(1),
  team: z.string().min(1).nullable(),
  role: Role.nullable(),
});
export type MeBody = z.infer<typeof MeBody>;

/**
 * One person in a Team, whatever their Role, as Warden stores them: their Clerk user id, their Role, and when they
 * first opened Warden. (Not "Member", which is the lowest Role.)
 */
export const TeamMember = z.object({
  userId: z.string().min(1),
  role: Role,
  joinedAt: z.iso.datetime(),
});
export type TeamMember = z.infer<typeof TeamMember>;

/** `GET /api/team/members`: every person in the signed-in person's Team. Names and emails come from Clerk. */
export const MembersBody = z.object({ members: z.array(TeamMember) });
export type MembersBody = z.infer<typeof MembersBody>;

/** `PUT /api/team/members/:userId/role`'s body: the Role to give. The answer is the person's `TeamMember`. */
export const RoleChangeBody = z.object({ role: Role });
export type RoleChangeBody = z.infer<typeof RoleChangeBody>;

export * from "./decisions.ts";
