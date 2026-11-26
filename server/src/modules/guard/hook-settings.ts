// A Team's hook token (Guard spec, story 7): what a laptop's managed hook sends so the hook endpoint knows its Team.
// Kept as one append-only row per token issued (0013_hook_tokens), holding its SHA-256 hash, never the token; the
// Team's newest row is its current token, and the one before it stays valid 24 h after a rotation. The token names its
// Team, so `teamFor` reads only that Team's rows: every call runs inside `withTeam`, never across Teams (ADR 0006).
// Beside it, the Team's Privacy tier: one row per Team in `guard_settings` (0014), replaced on each change.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrivacyTier } from "@warden/contracts";
import { sql, type Generated, type Selectable, type Transaction } from "kysely";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";

/**
 * Guard's hook tables, added to `withTeam`'s transaction with `$extendTables`, so `schema.ts` stays as it is. A type,
 * not an interface: `$extendTables` needs the index signature a type alias has.
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
  /** One row per Team that set its Privacy tier; a change replaces it (0014_guard_settings). */
  guard_settings: {
    team_id: string;
    privacy_tier: PrivacyTier;
    set_by: string;
    set_at: Generated<Date>;
  };
};

/** A Team's Privacy tier until an Admin sets one (GLOSSARY "Privacy tier"). */
const DEFAULT_TIER: PrivacyTier = "details";

/** How long the token before the newest keeps working after a rotation. */
const OVERLAP_MS = 24 * 3_600_000;

/**
 * A token: the Team's id, a dot, and 32 random bytes in base64url (43 characters, no dot). The Team part needs no
 * database to read, and is held to a Team id's alphabet: a Clerk Organization id is `org_` and letters and digits (the
 * tests' add a UUID's hyphens). So nothing `withTeam` or Postgres would refuse (a space, a NUL) reaches them.
 */
const TOKEN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

/** A token's SHA-256, as 64 hex digits: what the table holds. */
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new token: the only time it exists outside the caller. */
export type IssuedToken = { token: string; issuedAt: Date; previousValidUntil: Date | null };

/** The Team's token settings: its current token's issue time and when the one before stops working. Never a token. */
export type HookTokenSettings = { issuedAt: Date | null; previousValidUntil: Date | null };

/** The Team's hook settings: its token settings and its Privacy tier. */
export type TeamHookSettings = HookTokenSettings & { privacyTier: PrivacyTier };

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
  /**
   * The Team's current token's issue time (null with none), when the one before stops working (null when none), and
   * its Privacy tier (`details` until an Admin sets one).
   */
  read(team: string): Promise<TeamHookSettings>;
  /** Stores the Team's Privacy tier, with who set it, replacing the last: tier changes keep no history. */
  setPrivacyTier(team: string, change: { tier: PrivacyTier; setBy: string }): Promise<void>;
}

type Row = Selectable<HookTables["hook_tokens"]>;

/** The Team's `count` newest rows, newest first. */
const newest = (tx: Transaction<Database>, count: 1 | 2): Promise<Row[]> =>
  tx
    .$extendTables<HookTables>()
    .selectFrom("hook_tokens")
    .selectAll()
    .orderBy("id", "desc")
    .limit(count)
    .execute();

const newestTwo = (tx: Transaction<Database>) => newest(tx, 2);

/** When the token before a rotation stops working: 24 h after the rotation. */
const validUntil = (rotation: Date) => new Date(rotation.getTime() + OVERLAP_MS);

/** When the token before `current` stops working, or null when there is none before it. */
const previousEnd = (current: Row | undefined, previous: Row | undefined) =>
  current && previous ? validUntil(current.issued_at) : null;

/** Whether two hex hashes are equal, compared in constant time. */
const sameHash = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a, "hex"), Buffer.from(b, "hex")];
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `now` is the store's clock, in milliseconds: a test sets it to write a row in the past. */
export function createHookSettings({
  withTeam,
  now = Date.now,
}: {
  withTeam: WithTeam;
  now?: () => number;
}): HookSettings {
  return {
    issueToken(team, { issuedBy }) {
      const token = `${team}.${randomBytes(32).toString("base64url")}`;
      return withTeam(team, async (tx) => {
        // One rotation at a time per Team: the next reads the rows this one wrote, so its answer is the stored truth,
        // and the issue times follow the rows' order.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`hook_tokens:${team}`}, 0))`.execute(
          tx,
        );
        const [current] = await newest(tx, 1);
        const issuedAt = new Date(now());
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
        return { token, issuedAt, previousValidUntil: current ? validUntil(issuedAt) : null };
      });
    },

    async teamFor(token) {
      const team = TOKEN.exec(token)?.[1];
      if (team === undefined) return undefined;
      const [current, previous] = await withTeam(team, newestTwo);
      if (current === undefined) return undefined;
      const hash = hashOf(token);
      if (sameHash(hash, current.token_hash)) return team;
      const until = previousEnd(current, previous);
      if (previous && until && now() < until.getTime() && sameHash(hash, previous.token_hash)) {
        return team;
      }
      return undefined;
    },

    async read(team) {
      const { tokens, tier } = await withTeam(team, async (tx) => ({
        tokens: await newestTwo(tx),
        tier: await tx
          .$extendTables<HookTables>()
          .selectFrom("guard_settings")
          .select("privacy_tier")
          .executeTakeFirst(),
      }));
      const [current, previous] = tokens;
      const until = previousEnd(current, previous);
      return {
        issuedAt: current?.issued_at ?? null,
        previousValidUntil: until && now() < until.getTime() ? until : null,
        privacyTier: tier?.privacy_tier ?? DEFAULT_TIER,
      };
    },

    async setPrivacyTier(team, { tier, setBy }) {
      await withTeam(team, (tx) =>
        tx
          .$extendTables<HookTables>()
          .insertInto("guard_settings")
          .values({ team_id: team, privacy_tier: tier, set_by: setBy })
          .onConflict((conflict) =>
            conflict
              .column("team_id")
              .doUpdateSet({ privacy_tier: tier, set_by: setBy, set_at: sql<Date>`now()` }),
          )
          .execute(),
      );
    },
  };
}
