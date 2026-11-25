// A Team's hook token (Guard spec, story 7): issued once, rotated with the old token valid 24 h after, kept only as
// append-only SHA-256 hashes, and read back for the hook endpoint by `teamFor` from the token alone. Through the Guard
// module's store on withTeam, with a clock the test sets. It runs on a database of its own: the owner's truncate locks
// hook_tokens against every other file issuing tokens on the suite's shared database.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHookSettings,
  type HookSettings,
  type HookTables,
} from "../src/modules/guard/hook-settings.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { ADMIN, newTeam } from "./helpers.ts";

let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;
let withTeam: WithTeam;
let hookSettings: HookSettings;

/** The store's clock: now, unless a case sets it back to write a row in the past. */
let clock: Date | undefined;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  withTeam = withTeamAs.warden_app;
  hookSettings = createHookSettings({ withTeam, now: () => clock ?? new Date() });
}, 30_000);

afterAll(() => end?.(), 30_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Issues the Team's next token as if `msAgo` milliseconds ago, and answers it. */
async function issueAgo(team: string, msAgo: number) {
  clock = new Date(Date.now() - msAgo);
  try {
    return (await hookSettings.issueToken(team, { issuedBy: ADMIN })).token;
  } finally {
    clock = undefined;
  }
}

/** The Team's hook_tokens rows, oldest first, read as that Team. */
const rows = (team: string) =>
  withTeam(team, (tx) =>
    tx.$extendTables<HookTables>().selectFrom("hook_tokens").selectAll().orderBy("id").execute(),
  );

describe("issueToken", () => {
  it("answers a new token for a Team's first, with its time and no previous token", async () => {
    const team = await newTeam(withTeam);

    const issued = await hookSettings.issueToken(team, { issuedBy: ADMIN });

    expect(issued).toEqual({
      token: expect.any(String),
      issuedAt: expect.any(Date),
      previousValidUntil: null,
    });
    expect(await rows(team)).toMatchObject([{ team_id: team, issued_by: ADMIN }]);
  });

  it("answers a different token on a rotation, the old one valid until 24 h after it", async () => {
    const team = await newTeam(withTeam);
    const first = await hookSettings.issueToken(team, { issuedBy: ADMIN });

    const second = await hookSettings.issueToken(team, { issuedBy: ADMIN });

    expect(second.token).not.toBe(first.token);
    expect(second.previousValidUntil).toEqual(new Date(second.issuedAt.getTime() + 24 * HOUR));
    expect(await rows(team)).toHaveLength(2);
  });
});

describe("teamFor: the Team a token belongs to", () => {
  it("gives the Team for both the new token and the old one while the rotation is 23 h 59 min old", async () => {
    const team = await newTeam(withTeam);
    const old = await issueAgo(team, 30 * HOUR);
    const current = await issueAgo(team, 23 * HOUR + 59 * MINUTE);

    expect(await hookSettings.teamFor(current)).toBe(team);
    expect(await hookSettings.teamFor(old)).toBe(team);
  });

  it("gives undefined for the old token once the rotation is 24 h 1 min old, and the Team for the new one", async () => {
    const team = await newTeam(withTeam);
    const old = await issueAgo(team, 30 * HOUR);
    const current = await issueAgo(team, 24 * HOUR + MINUTE);

    expect(await hookSettings.teamFor(old)).toBeUndefined();
    expect(await hookSettings.teamFor(current)).toBe(team);
  });

  it("gives undefined for the first token after two rotations within the hour, and the Team for the second and third", async () => {
    const team = await newTeam(withTeam);
    const first = await issueAgo(team, 50 * MINUTE);
    const second = await issueAgo(team, 40 * MINUTE);
    const third = await issueAgo(team, 30 * MINUTE);

    expect(await hookSettings.teamFor(first)).toBeUndefined();
    expect(await hookSettings.teamFor(second)).toBe(team);
    expect(await hookSettings.teamFor(third)).toBe(team);
  });

  it("gives the Team for its only token", async () => {
    const team = await newTeam(withTeam);
    const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });

    expect(await hookSettings.teamFor(token)).toBe(team);
  });

  /** The token with its last `.`-separated part swapped: the Team part, then the random part. */
  const parts = (token: string) => {
    const at = token.lastIndexOf(".");
    return { team: token.slice(0, at), random: token.slice(at + 1) };
  };

  it.each<[string, () => Promise<string>]>([
    ["an empty string", async () => ""],
    ["a string not in the token's form", async () => "not a hook token"],
    ["a token with its random part cut short", async () => `org_x.${"a".repeat(42)}`],
    ["a token with spaces around its Team part", async () => ` org_x .${"a".repeat(43)}`],
    [
      "Team A's token with its Team part changed to Team B's id",
      async () => {
        const teamA = await newTeam(withTeam);
        const teamB = await newTeam(withTeam);
        await hookSettings.issueToken(teamB, { issuedBy: ADMIN });
        const { token } = await hookSettings.issueToken(teamA, { issuedBy: ADMIN });
        return `${teamB}.${parts(token).random}`;
      },
    ],
    [
      "a token for a Team with no tokens",
      async () => `${await newTeam(withTeam)}.${randomBytes(32).toString("base64url")}`,
    ],
    [
      "Team A's newest token with one character of its random part changed",
      async () => {
        const team = await newTeam(withTeam);
        const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });
        const { random } = parts(token);
        const changed = random[0] === "A" ? "B" : "A";
        return `${team}.${changed}${random.slice(1)}`;
      },
    ],
  ])("gives undefined, without throwing, for %s", async (_name, token) => {
    expect(await hookSettings.teamFor(await token())).toBeUndefined();
  });
});

describe("read: the Team's token settings, never a token", () => {
  it("answers no token for a Team with none", async () => {
    const team = await newTeam(withTeam);

    expect(await hookSettings.read(team)).toEqual({ issuedAt: null, previousValidUntil: null });
  });

  it("answers the current token's time, and when the token before it stops working", async () => {
    const team = await newTeam(withTeam);
    await issueAgo(team, 2 * HOUR);
    const { issuedAt, previousValidUntil } = await hookSettings.issueToken(team, {
      issuedBy: ADMIN,
    });

    expect(await hookSettings.read(team)).toEqual({ issuedAt, previousValidUntil });
  });

  it("answers no previous token once it has stopped working", async () => {
    const team = await newTeam(withTeam);
    await issueAgo(team, 30 * HOUR);
    await issueAgo(team, 25 * HOUR);

    expect(await hookSettings.read(team)).toEqual({
      issuedAt: expect.any(Date),
      previousValidUntil: null,
    });
  });
});

const attempts = {
  update: sql`update hook_tokens set issued_by = 'user_other'`,
  delete: sql`delete from hook_tokens`,
  truncate: sql`truncate hook_tokens`,
};

describe("hook_tokens is append-only", () => {
  let team: string;

  beforeAll(async () => {
    team = await newTeam(withTeam);
    await hookSettings.issueToken(team, { issuedBy: ADMIN });
  });

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses warden_app's %s, which has no grant for it, and the rows are unchanged",
    async (command) => {
      const before = await rows(team);
      expect(before).toHaveLength(1);

      await expect(withTeam(team, (tx) => attempts[command].execute(tx))).rejects.toThrow(
        /permission denied for table hook_tokens/,
      );

      expect(await rows(team)).toEqual(before);
    },
  );

  it.each(Object.keys(attempts) as (keyof typeof attempts)[])(
    "refuses the owner's (warden_migrate's) %s with an error naming it append-only, and the rows are unchanged",
    async (command) => {
      const before = await rows(team);

      await expect(
        withTeamAs.warden_migrate(team, (tx) => attempts[command].execute(tx)),
      ).rejects.toThrow(/hook_tokens is append-only/);

      expect(await rows(team)).toEqual(before);
    },
  );
});
