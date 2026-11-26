// A Team's hook token (Guard spec, story 7): rotated with the old token valid 24 h after, kept only as append-only
// SHA-256 hashes, and read back for the hook endpoint by `teamFor` from the token alone. Through the Guard module's
// store on withTeam; a case that moves time has a store with a clock of its own. The API tests prove what a POST and a
// GET answer. It runs on a database of its own: the owner's truncate locks hook_tokens against every other file
// issuing tokens on the suite's shared database.
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHookSettings, type HookSettings } from "../src/modules/guard/hook-settings.ts";
import type { WithTeam } from "../src/with-team.ts";
import { ownDatabase } from "./databases.ts";
import { ADMIN, hookTokenRows, newTeam } from "./helpers.ts";

let withTeamAs: Record<"warden_app" | "warden_migrate", WithTeam>;
let end: (() => Promise<void>) | undefined;
let withTeam: WithTeam;
/** The store on the real clock, for cases that don't move time. */
let hookSettings: HookSettings;

beforeAll(async () => {
  ({ withTeamAs, end } = await ownDatabase(["warden_app", "warden_migrate"]));
  withTeam = withTeamAs.warden_app;
  hookSettings = createHookSettings({ withTeam });
}, 30_000);

afterAll(() => end?.(), 30_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const rows = (team: string) => hookTokenRows(withTeam, team);

/** A clock that moves only when a case advances it. */
function fakeClock(start = Date.now()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** A store on a clock of its own, and a way to issue the Team's next token on it. */
function clockedStore() {
  const clock = fakeClock();
  const store = createHookSettings({ withTeam, now: clock.now });
  const issue = async (team: string) => (await store.issueToken(team, { issuedBy: ADMIN })).token;
  return { clock, store, issue };
}

/** `withTeam`, but each call's work waits until `count` calls have their transactions open, so they run at once. */
function together(count: number): WithTeam {
  let open = 0;
  let allOpen = () => {};
  const opened = new Promise<void>((resolve) => (allOpen = resolve));
  return (team, work) =>
    withTeam(team, async (tx) => {
      if (++open === count) allOpen();
      await opened;
      return work(tx);
    });
}

describe("issueToken: rotations at once", () => {
  it("answers two rotations at once as their stored rows say: the second's previous token is the first's", async () => {
    const team = await newTeam(withTeam);
    const atOnce = createHookSettings({ withTeam: together(2) });

    const answers = await Promise.all([
      atOnce.issueToken(team, { issuedBy: ADMIN }),
      atOnce.issueToken(team, { issuedBy: ADMIN }),
    ]);

    const stored = await rows(team);
    const answerFor = (hash: string) =>
      answers.find(({ token }) => createHash("sha256").update(token).digest("hex") === hash);
    expect(stored.map((row) => answerFor(row.token_hash)?.previousValidUntil)).toEqual(
      stored.map((row, at) => (at === 0 ? null : new Date(row.issued_at.getTime() + 24 * HOUR))),
    );
  });
});

describe("teamFor: the Team a token belongs to", () => {
  it("gives the Team for both the new token and the old one while the rotation is 23 h 59 min old", async () => {
    const { clock, store, issue } = clockedStore();
    const team = await newTeam(withTeam);
    const old = await issue(team);
    clock.advance(6 * HOUR);
    const current = await issue(team);

    clock.advance(23 * HOUR + 59 * MINUTE);

    expect(await store.teamFor(current)).toBe(team);
    expect(await store.teamFor(old)).toBe(team);
  });

  it("gives undefined for the old token once the rotation is 24 h 1 min old, and the Team for the new one", async () => {
    const { clock, store, issue } = clockedStore();
    const team = await newTeam(withTeam);
    const old = await issue(team);
    clock.advance(6 * HOUR);
    const current = await issue(team);

    clock.advance(24 * HOUR + MINUTE);

    expect(await store.teamFor(old)).toBeUndefined();
    expect(await store.teamFor(current)).toBe(team);
  });

  it("gives undefined for the first token after two rotations within the hour, and the Team for the second and third", async () => {
    const { clock, store, issue } = clockedStore();
    const team = await newTeam(withTeam);
    const first = await issue(team);
    clock.advance(10 * MINUTE);
    const second = await issue(team);
    clock.advance(10 * MINUTE);
    const third = await issue(team);

    clock.advance(30 * MINUTE);

    expect(await store.teamFor(first)).toBeUndefined();
    expect(await store.teamFor(second)).toBe(team);
    expect(await store.teamFor(third)).toBe(team);
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
    ["a token with a NUL in its Team part", async () => `org_x\u0000.${"a".repeat(43)}`],
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
  it("answers no previous token once it has stopped working", async () => {
    const { clock, store, issue } = clockedStore();
    const team = await newTeam(withTeam);
    await issue(team);
    clock.advance(5 * HOUR);
    await issue(team);

    clock.advance(25 * HOUR);

    expect(await store.read(team)).toEqual({
      issuedAt: expect.any(Date),
      previousValidUntil: null,
      privacyTier: "details",
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
