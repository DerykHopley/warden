// The members module: each person's Role in their Team (ADR 0008). Clerk says who someone is and which Team they're
// in; Warden's own `team_members` table says their Role. Opening Warden is what puts them there: the Team's Clerk
// org:admin creates the Team as its Admin, and anyone else joins an existing Team as a Member. Every call reaches the
// database through withTeam, one transaction each (ADR 0006), and every change appends a Role history row.
import { sql, type Transaction } from "kysely";
import type { Role } from "@warden/contracts";
import type { Database } from "./schema.ts";
import type { WithTeam } from "./with-team.ts";

/** A person opening Warden in a Team, as their verified session token says. */
export type Visitor = {
  team: string;
  userId: string;
  /** Their Clerk role in the Team, `org:admin` or `org:member`; it decides only who may create the Team. */
  clerkRole: string | null;
};

export type Opened =
  | { kind: "member"; role: Role }
  /** The Team has no row yet, and this person isn't the one who may create it. Nothing was written. */
  | { kind: "team not created" };

export type Members = {
  /** The visitor's Role in their Team, after the first-use steps: create the Team, or join it. */
  open(visitor: Visitor): Promise<Opened>;
};

/** Clerk makes whoever creates an Organization its `org:admin`. */
const CLERK_ADMIN = "org:admin";

export function createMembers({ withTeam }: { withTeam: WithTeam }): Members {
  return {
    open: (visitor) =>
      withTeam(visitor.team, async (tx) => {
        const known = await roleOf(tx, visitor.userId);
        if (known !== undefined) return { kind: "member", role: known };

        // First use, by this person or of this Team: one at a time per Team, so two first visits at once give one
        // Team and one history row. Read again under the lock, as the other visit may have just written it.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`team_members:${visitor.team}`}::text, 0))`.execute(
          tx,
        );
        const role = await roleOf(tx, visitor.userId);
        if (role !== undefined) return { kind: "member", role };

        const team = await tx.selectFrom("teams").select("id").executeTakeFirst();
        if (team === undefined) {
          if (visitor.clerkRole !== CLERK_ADMIN) return { kind: "team not created" };
          await tx.insertInto("teams").values({ id: visitor.team }).execute();
          await join(tx, visitor, "admin", "created_team");
          return { kind: "member", role: "admin" };
        }
        // Their Clerk role doesn't raise this: a Warden Role above Member is given in Warden (#30).
        await join(tx, visitor, "member", "joined");
        return { kind: "member", role: "member" };
      }),
  };
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
  change: "created_team" | "joined",
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
