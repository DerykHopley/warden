// A Team's hook token (Guard spec, story 7): what a laptop's managed hook sends so the hook endpoint knows its Team.
// Kept as one append-only row per token issued (0011_hook_tokens), holding its SHA-256 hash, never the token; the
// Team's newest row is its current token, and the one before it stays valid 24 h after a rotation. The token names its
// Team, so `teamFor` reads only that Team's rows: every call runs inside `withTeam`, never across Teams (ADR 0006).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Generated, Selectable, Transaction } from "kysely";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";

/**
 * Guard's hook token table, added to `withTeam`'s transaction with `$extendTables`, so `schema.ts` stays as it is. A
 * type, not an interface: `$extendTables` needs the index signature a type alias has.
 */
export type HookTables = {
  /** Append-only: one row per token issued. A trigger refuses update, delete, truncate. */
  hook_tokens: {
    team_id: string;
    id: Generated<string>;
    token_hash: string;
    issued_by: string;
    issued_at: Date;
  };
};

/** How long the token before the newest keeps working after a rotation. */
const OVERLAP_MS = 24 * 3_600_000;

/**
 * A token: the Team's id, a dot, and 32 random bytes in base64url (43 characters, no dot). The Team part is split off
 * at the last dot, so it needs no database to read, and holds no space, which `withTeam` would refuse.
 */
const TOKEN = /^(\S+)\.([A-Za-z0-9_-]{43})$/;

/** A token's SHA-256, as 64 hex digits: what the table holds. */
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new token: the only time it exists outside the caller. */
export type IssuedToken = { token: string; issuedAt: Date; previousValidUntil: Date | null };

/** The Team's token settings: its current token's issue time and when the one before stops working. Never a token. */
export type HookTokenSettings = { issuedAt: Date | null; previousValidUntil: Date | null };

export interface HookSettings {
  /**
   * Makes the Team's first token or its next one, stores its hash as a new row, and answers the token once, with its
   * time and when the token before it stops working (null for the Team's first).
   */
  issueToken(team: string, by: { issuedBy: string }): Promise<IssuedToken>;
  /**
   * The Team `token` belongs to, or undefined: valid are the Team's newest token, and the one before it until 24 h
   * after the newest was issued. Never throws for a malformed token.
   */
  teamFor(token: string): Promise<string | undefined>;
  /** The Team's current token's issue time (null with none), and when the one before stops working (null when none). */
  read(team: string): Promise<HookTokenSettings>;
}

type Row = Selectable<HookTables["hook_tokens"]>;

/** The Team's two newest rows, newest first. */
const newestTwo = (tx: Transaction<Database>): Promise<Row[]> =>
  tx
    .$extendTables<HookTables>()
    .selectFrom("hook_tokens")
    .selectAll()
    .orderBy("id", "desc")
    .limit(2)
    .execute();

/** When the token before `newest` stops working: 24 h after `newest`, or null when there is none before it. */
const previousEnd = (newest: Row | undefined, previous: Row | undefined) =>
  newest && previous ? new Date(newest.issued_at.getTime() + OVERLAP_MS) : null;

/** Whether two hex hashes are equal, compared in constant time. */
const sameHash = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a, "hex"), Buffer.from(b, "hex")];
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `now` is the store's clock: a test sets it to write a row in the past. */
export function createHookSettings({
  withTeam,
  now = () => new Date(),
}: {
  withTeam: WithTeam;
  now?: () => Date;
}): HookSettings {
  return {
    issueToken(team, { issuedBy }) {
      const token = `${team}.${randomBytes(32).toString("base64url")}`;
      const issuedAt = now();
      return withTeam(team, async (tx) => {
        const [previous] = await newestTwo(tx);
        await tx
          .$extendTables<HookTables>()
          .insertInto("hook_tokens")
          .values({
            team_id: team,
            token_hash: hashOf(token),
            issued_by: issuedBy,
            issued_at: issuedAt,
          })
          .execute();
        const previousValidUntil = previous ? new Date(issuedAt.getTime() + OVERLAP_MS) : null;
        return { token, issuedAt, previousValidUntil };
      });
    },

    async teamFor(token) {
      const team = TOKEN.exec(token)?.[1];
      if (team === undefined) return undefined;
      const [newest, previous] = await withTeam(team, newestTwo);
      if (newest === undefined) return undefined;
      const hash = hashOf(token);
      if (sameHash(hash, newest.token_hash)) return team;
      const until = previousEnd(newest, previous);
      if (previous && until && now() < until && sameHash(hash, previous.token_hash)) return team;
      return undefined;
    },

    async read(team) {
      const [newest, previous] = await withTeam(team, newestTwo);
      const until = previousEnd(newest, previous);
      return {
        issuedAt: newest?.issued_at ?? null,
        previousValidUntil: until && now() < until ? until : null,
      };
    },
  };
}
