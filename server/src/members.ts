// The members module: each person's Role in their Team (ADR 0008). Clerk says who someone is and which Team they're
// in; Warden's own `team_members` table says their Role. Opening Warden is what puts them there: the Team's Clerk
// org:admin creates the Team as its Admin, and anyone else joins an existing Team as a Member. Every call reaches the
// database through withTeam, one transaction each (ADR 0006), and every change appends a Role history row. An Admin
// gives Roles; a Warden Admin is Clerk's org:admin too, kept in step through the Clerk seam, and a Team always keeps
// one Admin (threat A8).
import { sql, type Transaction } from "kysely";
import type { Role } from "@warden/contracts";
import type { Database, RoleChange } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** What Warden asks of Clerk's Backend API: one person's Clerk role in one Organization. */
export type MembershipRoleChange = {
  organizationId: string;
  userId: string;
  role: "org:admin" | "org:member";
};

/** The Clerk seam: production calls Clerk's `updateOrganizationMembership`; tests pass a fake. Throws when Clerk refuses. */
export type ClerkOrganizations = {
  setMembershipRole(change: MembershipRoleChange): Promise<void>;
};

/** One person's row in their Team (the API sends it as the contracts' `Member`, `joinedAt` as an ISO string). */
export type TeamMember = { userId: string; role: Role; joinedAt: Date };

/** An Admin (`actorId`) giving `userId` the Role `role` in `team`. */
export type RoleChangeRequest = { team: string; userId: string; role: Role; actorId: string };

export type RoleChanged =
  /** Written: the row, one `changed` history row, and Clerk told when Admin was given or taken away. */
  | { kind: "changed"; member: TeamMember }
  /** They already had that Role: nothing written, Clerk not called. */
  | { kind: "unchanged"; member: TeamMember }
  /** Nobody with that user id is in the Team (or they haven't opened Warden yet). */
  | { kind: "no_such_member" }
  /** It would leave the Team with no Admin. Nothing written, Clerk not called. */
  | { kind: "last_admin" }
  /** Clerk's call threw, so the transaction rolled back: nothing changed. `error` is Clerk's, for the log. */
  | { kind: "clerk_refused"; error: unknown };

/** A person opening Warden in a Team, as their verified session token says. */
export type Visitor = {
  team: string;
  userId: string;
  /** Their Clerk role in the Team, `org:admin` or `org:member`; it decides only who may create the Team. */
  clerkRole: string | null;
};

export type Opened =
  | { kind: "in_team"; role: Role }
  /** The Team has no row yet, and this person isn't the one who may create it. Nothing was written. */
  | { kind: "team_not_created" };

export type Members = {
  /** The visitor's Role in their Team, after the first-use steps: create the Team, or join it. */
  open(visitor: Visitor): Promise<Opened>;
  /** Everyone in `team`, oldest member first. */
  list(team: string): Promise<TeamMember[]>;
  /** Gives a person a Role, as an Admin. The caller checks the actor is an Admin. */
  changeRole(request: RoleChangeRequest): Promise<RoleChanged>;
};

/** Clerk makes whoever creates an Organization its `org:admin`. */
const CLERK_ADMIN = "org:admin";

/** Thrown inside the transaction so it rolls back, and turned into `clerk_refused` outside it. */
class ClerkRefused extends Error {
  readonly clerkError: unknown;
  constructor(clerkError: unknown) {
    super("Clerk refused the membership change");
    this.clerkError = clerkError;
  }
}

export function createMembers({
  withTeam,
  clerkOrganizations,
}: {
  withTeam: WithTeam;
  clerkOrganizations: ClerkOrganizations;
}): Members {
  return {
    open: (visitor) =>
      withTeam(visitor.team, async (tx) => {
        const known = await roleOf(tx, visitor.userId);
        if (known !== undefined) return { kind: "in_team", role: known };

        // First use, by this person or of this Team: one at a time per Team, so two first visits at once give one
        // Team and one history row. Read again under the lock, as the other visit may have just written it.
        await lockTeam(tx, visitor.team);
        const role = await roleOf(tx, visitor.userId);
        if (role !== undefined) return { kind: "in_team", role };

        const team = await tx.selectFrom("teams").select("id").executeTakeFirst();
        if (team === undefined) {
          if (visitor.clerkRole !== CLERK_ADMIN) return { kind: "team_not_created" };
          await tx.insertInto("teams").values({ id: visitor.team }).execute();
          await join(tx, visitor, "admin", "created_team");
          return { kind: "in_team", role: "admin" };
        }
        // Their Clerk role doesn't raise this: a Warden Role above Member is given in Warden (#30).
        await join(tx, visitor, "member", "joined");
        return { kind: "in_team", role: "member" };
      }),

    list: (team) =>
      withTeam(team, async (tx) => {
        const rows = await tx
          .selectFrom("team_members")
          .select(["user_id", "role", "joined_at"])
          .orderBy("joined_at")
          .orderBy("user_id")
          .execute();
        return rows.map(toMember);
      }),

    changeRole: async ({ team, userId, role, actorId }) => {
      try {
        return await withTeam(team, async (tx): Promise<RoleChanged> => {
          // The same lock as a first visit, before anything is read: two Admins demoting each other at once, or a
          // change beside a first visit, run one at a time, so the last-Admin count below can't go stale.
          await lockTeam(tx, team);
          const row = await tx
            .selectFrom("team_members")
            .select(["user_id", "role", "joined_at"])
            .where("user_id", "=", userId)
            .executeTakeFirst();
          if (row === undefined) return { kind: "no_such_member" };
          if (row.role === role) return { kind: "unchanged", member: toMember(row) };

          if (row.role === "admin") {
            const admins = await tx
              .selectFrom("team_members")
              .select((eb) => eb.fn.countAll<string>().as("count"))
              .where("role", "=", "admin")
              .executeTakeFirstOrThrow();
            if (Number(admins.count) <= 1) return { kind: "last_admin" };
          }

          await tx
            .updateTable("team_members")
            .set({ role })
            .where("user_id", "=", userId)
            .execute();
          await tx
            .insertInto("role_history")
            .values({
              team_id: team,
              user_id: userId,
              role_before: row.role,
              role_after: role,
              change: "changed",
              actor_id: actorId,
            })
            .execute();

          // Clerk last, before the commit: when it refuses, the writes above roll back with it. Between Member and
          // Lead Clerk's role doesn't move, so it isn't called. If Clerk takes the change and the commit then fails,
          // the two disagree until the next change (threat A8's leftover, accepted for now).
          if ((row.role === "admin") !== (role === "admin")) {
            try {
              await clerkOrganizations.setMembershipRole({
                organizationId: team,
                userId,
                role: role === "admin" ? "org:admin" : "org:member",
              });
            } catch (error) {
              throw new ClerkRefused(error);
            }
          }
          return { kind: "changed", member: toMember({ ...row, role }) };
        });
      } catch (error) {
        if (error instanceof ClerkRefused)
          return { kind: "clerk_refused", error: error.clerkError };
        throw error;
      }
    },
  };
}

/** Holds the Team's members lock until the transaction ends. */
async function lockTeam(tx: Transaction<Database>, team: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`team_members:${team}`}::text, 0))`.execute(
    tx,
  );
}

function toMember(row: { user_id: string; role: Role; joined_at: Date }): TeamMember {
  return { userId: row.user_id, role: row.role, joinedAt: row.joined_at };
}

async function roleOf(tx: Transaction<Database>, userId: string): Promise<Role | undefined> {
  const row = await tx
    .selectFrom("team_members")
    .select("role")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role;
}

async function join(
  tx: Transaction<Database>,
  visitor: Visitor,
  role: Role,
  change: Exclude<RoleChange, "changed">,
) {
  await tx
    .insertInto("team_members")
    .values({ team_id: visitor.team, user_id: visitor.userId, role })
    .execute();
  await tx
    .insertInto("role_history")
    .values({
      team_id: visitor.team,
      user_id: visitor.userId,
      role_before: null,
      role_after: role,
      change,
      actor_id: visitor.userId,
    })
    .execute();
}
