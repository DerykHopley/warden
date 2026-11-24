// The members module: each person's Role in their Team (ADR 0008). Clerk says who someone is and which Team they're
// in; Warden's own `team_members` table says their Role. Opening Warden is what puts them there: the Team's Clerk
// org:admin creates the Team as its Admin, and anyone else joins an existing Team as a Member. Every call reaches the
// database through withTeam, one transaction each (ADR 0006), and every change appends a Role history row. An Admin
// gives Roles; a Warden Admin is Clerk's org:admin and nobody else is, kept in step through the Clerk seam, and a Team
// always keeps one Admin (threat A8).
import { sql, type Transaction } from "kysely";
import type { Role } from "@warden/contracts";
import type { Logger } from "./log.ts";
import type { Database, RoleChange } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** What Warden asks of Clerk's Backend API: one person's Clerk role in one Organization. */
export type MembershipRoleChange = {
  organizationId: string;
  userId: string;
  role: ClerkRole;
};

type ClerkRole = "org:admin" | "org:member";

/** Clerk set the role, or has no such membership (the person left the Organization). */
export type ClerkAnswer = "set" | "not_a_member";

/** The Clerk seam: production calls Clerk's `updateOrganizationMembership`; tests pass a fake. Throws when Clerk refuses. */
export type ClerkOrganizations = {
  setMembershipRole(change: MembershipRoleChange): Promise<ClerkAnswer>;
};

/** One person's row in their Team (the API sends it as the contracts' `TeamMember`, `joinedAt` as an ISO string). */
export type TeamMemberRow = { userId: string; role: Role; joinedAt: Date };

/** An Admin (`actorId`) giving `userId` the Role `role` in `team`. */
export type RoleChangeRequest = { team: string; userId: string; role: Role; actorId: string };

export type RoleChanged =
  /** Written: the row and one `changed` history row; Clerk told when Admin was given or taken away. */
  | { kind: "changed"; member: TeamMemberRow }
  /** They already had that Role: nothing written; Clerk told that Role's Clerk role again, to heal a mismatch. */
  | { kind: "unchanged"; member: TeamMemberRow }
  /** Nobody with that user id is in the Team (or they haven't opened Warden yet). */
  | { kind: "no_such_member" }
  /** It would leave the Team with no Admin. Nothing written, Clerk not called. */
  | { kind: "last_admin" }
  /** The actor isn't an Admin any more (a change committed while theirs waited for the lock). Nothing written. */
  | { kind: "not_admin" }
  /** Clerk refused, or didn't answer in time, so the transaction rolled back: nothing changed. */
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
  list(team: string): Promise<TeamMemberRow[]>;
  /** Gives a person a Role. The actor must be an Admin; it's checked again under the Team's lock. */
  changeRole(request: RoleChangeRequest): Promise<RoleChanged>;
};

/** Clerk makes whoever creates an Organization its `org:admin`. */
const CLERK_ADMIN = "org:admin";

/** How long a change waits for Clerk while it holds the Team's lock and a connection. */
const CLERK_TIMEOUT_MS = 5000;

/** The key of a Team's members lock (`pg_advisory_xact_lock`), which first visits and Role changes take. */
export function teamLockKey(team: string): string {
  return `team_members:${team}`;
}

/** Thrown inside the transaction so it rolls back, and turned into `clerk_refused` outside it. */
class ClerkRefused extends Error {
  constructor(cause: unknown) {
    super("Clerk refused the membership change", { cause });
  }
}

const MEMBER_COLUMNS = ["user_id", "role", "joined_at"] as const;

export function createMembers({
  withTeam,
  clerkOrganizations,
  logger,
  clerkTimeoutMs = CLERK_TIMEOUT_MS,
}: {
  withTeam: WithTeam;
  clerkOrganizations: ClerkOrganizations;
  logger: Logger;
  clerkTimeoutMs?: number;
}): Members {
  /** Clerk's answer, or a throw when it refuses or takes longer than `clerkTimeoutMs`. */
  async function setClerkRole(change: MembershipRoleChange): Promise<ClerkAnswer> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Clerk didn't answer within ${clerkTimeoutMs} ms`)),
        clerkTimeoutMs,
      );
    });
    try {
      return await Promise.race([clerkOrganizations.setMembershipRole(change), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    open: async (visitor) => {
      const opened = await withTeam(
        visitor.team,
        async (tx): Promise<Opened & { joined?: boolean }> => {
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
          // Their Clerk role doesn't raise this: a Warden Role above Member is given in Warden.
          await join(tx, visitor, "member", "joined");
          return { kind: "in_team", role: "member", joined: true };
        },
      );
      if (opened.kind !== "in_team") return opened;

      // Clerk's org:admin is a Warden Admin and nobody else (ADR 0008): someone Clerk calls org:admin who joins as a
      // Member is set to org:member. After the commit, as a failure here mustn't keep them out: it's logged.
      if (opened.joined && visitor.clerkRole === CLERK_ADMIN) {
        const change = {
          organizationId: visitor.team,
          userId: visitor.userId,
          role: "org:member",
        } as const;
        try {
          if ((await setClerkRole(change)) === "not_a_member")
            logger.warn("Clerk has no membership for a person joining their Team", change);
        } catch (error) {
          logger.error("couldn't set a joining person's Clerk role to org:member", {
            ...change,
            error,
          });
        }
      }
      return { kind: "in_team", role: opened.role };
    },

    list: (team) =>
      withTeam(team, async (tx) => {
        const rows = await tx
          .selectFrom("team_members")
          .select(MEMBER_COLUMNS)
          .orderBy("joined_at")
          .orderBy("user_id")
          .execute();
        return rows.map(toRow);
      }),

    changeRole: async ({ team, userId, role, actorId }) => {
      try {
        return await withTeam(team, async (tx): Promise<RoleChanged> => {
          // The same lock as a first visit, before anything is read: two Admins demoting each other at once, or a
          // change beside a first visit, run one at a time, so what's read below can't go stale.
          await lockTeam(tx, team);
          const row = await memberRow(tx, userId);
          if (row === undefined) return { kind: "no_such_member" };

          // The last-Admin rule before the actor's check, so two Admins demoting each other at once get 409: the
          // loser's change would leave no Admin, whoever asked for it.
          if (row.role === "admin" && role !== "admin") {
            const admins = await tx
              .selectFrom("team_members")
              .select((eb) => eb.fn.countAll<string>().as("count"))
              .where("role", "=", "admin")
              .executeTakeFirstOrThrow();
            if (Number(admins.count) <= 1) return { kind: "last_admin" };
          }

          // requireRole read the actor's Role before the lock; a change that committed since may have taken it.
          if ((await memberRow(tx, actorId))?.role !== "admin") return { kind: "not_admin" };

          const clerkRole: ClerkRole = role === "admin" ? "org:admin" : "org:member";
          if (row.role === role) {
            // Nothing to write, but Clerk is told again: a retry heals Clerk and Warden disagreeing (A8's leftover).
            await syncClerk({ organizationId: team, userId, role: clerkRole });
            return { kind: "unchanged", member: toRow(row) };
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
          // the two disagree until the change is sent again (threat A8's leftover, accepted for now).
          if ((row.role === "admin") !== (role === "admin")) {
            await syncClerk({ organizationId: team, userId, role: clerkRole });
          }
          return { kind: "changed", member: toRow({ ...row, role }) };
        });
      } catch (error) {
        if (error instanceof ClerkRefused) return { kind: "clerk_refused", error: error.cause };
        throw error;
      }
    },
  };

  /**
   * Sets the Clerk role from inside a change's transaction, throwing ClerkRefused to roll it back. Clerk having no such
   * membership is no reason to keep someone a Warden Admin, so a change to `org:member` goes on, with a warning; a
   * change to `org:admin` can't.
   */
  async function syncClerk(change: MembershipRoleChange) {
    let answer: ClerkAnswer;
    try {
      answer = await setClerkRole(change);
    } catch (error) {
      throw new ClerkRefused(error);
    }
    if (answer === "set") return;
    if (change.role === "org:admin") {
      throw new ClerkRefused(new Error("Clerk has no membership to make org:admin"));
    }
    logger.warn("Clerk has no membership for this person; Warden's Role change is kept", change);
  }
}

/** Holds the Team's members lock until the transaction ends. */
async function lockTeam(tx: Transaction<Database>, team: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${teamLockKey(team)}::text, 0))`.execute(
    tx,
  );
}

function memberRow(tx: Transaction<Database>, userId: string) {
  return tx
    .selectFrom("team_members")
    .select(MEMBER_COLUMNS)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

function toRow(row: { user_id: string; role: Role; joined_at: Date }): TeamMemberRow {
  return { userId: row.user_id, role: row.role, joinedAt: row.joined_at };
}

async function roleOf(tx: Transaction<Database>, userId: string): Promise<Role | undefined> {
  return (await memberRow(tx, userId))?.role;
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
