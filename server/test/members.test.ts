// Story 1 at the API: opening Warden is what creates a Team (for its Clerk org:admin) or joins it (as a Member), and
// GET /api/me answers the person's Team and Role from Warden's own table (ADR 0008). Each case uses Teams of its own
// in the suite's shared database, read back through withTeam.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Hono } from "hono";
import type { AppEnv } from "../src/app.ts";
import type { ClerkAnswer, MembershipRoleChange } from "../src/members.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({ publicPem, withTeam }));
});

afterAll(async () => {
  await pool.end();
});

const newTeam = () => `org_${randomUUID()}`;

async function me(userId: string, team?: string, clerkRole: "admin" | "member" = "member") {
  const claims = team === undefined ? {} : activeOrganization(team, clerkRole);
  const token = await sessionToken(key, userId, 60, claims);
  const res = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

/** Everything stored for `team`, read as that Team. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    teams: await tx.selectFrom("teams").select("id").execute(),
    members: await tx
      .selectFrom("team_members")
      .select(["user_id", "role"])
      .orderBy("user_id")
      .execute(),
    history: await tx
      .selectFrom("role_history")
      .select(["user_id", "role_before", "role_after", "change", "actor_id"])
      .orderBy("id")
      .execute(),
  }));
}

describe("a Team's first visit", () => {
  it("by its Clerk org:admin creates the Team, with them as its Admin and one created_team row", async () => {
    const team = newTeam();

    expect(await me("user_founder", team, "admin")).toEqual({
      status: 200,
      body: { userId: "user_founder", team, role: "admin", level: "quick" },
    });

    expect(await stored(team)).toEqual({
      teams: [{ id: team }],
      members: [{ user_id: "user_founder", role: "admin" }],
      history: [
        {
          user_id: "user_founder",
          role_before: null,
          role_after: "admin",
          change: "created_team",
          actor_id: "user_founder",
        },
      ],
    });
  });

  it("by someone Clerk doesn't call org:admin answers 409 and writes nothing", async () => {
    const team = newTeam();

    expect(await me("user_early", team, "member")).toEqual({
      status: 409,
      body: { error: "Your Team's Admin must open Warden first" },
    });

    expect(await stored(team)).toEqual({ teams: [], members: [], history: [] });
  });

  it("twice at once leaves one Team and one created_team row", async () => {
    const team = newTeam();

    const answers = await Promise.all([
      me("user_founder", team, "admin"),
      me("user_founder", team, "admin"),
    ]);

    for (const answer of answers) {
      expect(answer).toEqual({
        status: 200,
        body: { userId: "user_founder", team, role: "admin", level: "quick" },
      });
    }
    const { teams, members, history } = await stored(team);
    expect(teams).toHaveLength(1);
    expect(members).toEqual([{ user_id: "user_founder", role: "admin" }]);
    expect(history.map((row) => row.change)).toEqual(["created_team"]);
  });
});

describe("an invited person's first visit", () => {
  it("joins them as a Member with one joined row, even when Clerk calls them org:admin; a second adds nothing", async () => {
    const team = newTeam();
    await me("user_founder", team, "admin");

    expect(await me("user_invited", team, "admin")).toEqual({
      status: 200,
      body: { userId: "user_invited", team, role: "member", level: "quick" },
    });
    expect(await me("user_invited", team, "admin")).toEqual({
      status: 200,
      body: { userId: "user_invited", team, role: "member", level: "quick" },
    });

    const { members, history } = await stored(team);
    expect(members).toEqual([
      { user_id: "user_founder", role: "admin" },
      { user_id: "user_invited", role: "member" },
    ]);
    expect(history.filter((row) => row.user_id === "user_invited")).toEqual([
      {
        user_id: "user_invited",
        role_before: null,
        role_after: "member",
        change: "joined",
        actor_id: "user_invited",
      },
    ]);
  });

  it.each([
    ["sets their Clerk role to org:member", async (): Promise<ClerkAnswer> => "set", false],
    [
      "still lets them in when Clerk refuses, and logs it",
      async (): Promise<ClerkAnswer> => {
        throw new Error("Clerk is down");
      },
      true,
    ],
  ] as const)(
    "of someone Clerk calls org:admin %s, as a Warden Member isn't Clerk's org:admin",
    async (_name, then, logged) => {
      const team = newTeam();
      await me("user_founder", team, "admin");
      const calls: MembershipRoleChange[] = [];
      const { app: syncing, lines } = testApp({
        publicPem,
        withTeam,
        clerkOrganizations: {
          setMembershipRole: async (change) => {
            calls.push(change);
            return then();
          },
        },
      });
      const token = await sessionToken(
        key,
        "user_clerk_admin",
        60,
        activeOrganization(team, "admin"),
      );
      const open = () =>
        syncing.request("/api/me", { headers: { Authorization: `Bearer ${token}` } });

      const res = await open();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        userId: "user_clerk_admin",
        team,
        role: "member",
        level: "quick",
      });
      expect(calls).toEqual([
        { organizationId: team, userId: "user_clerk_admin", role: "org:member" },
      ]);
      expect(lines.some((line) => line.includes("Clerk is down"))).toBe(logged);
      // Only on joining: a second visit doesn't call Clerk.
      expect((await open()).status).toBe(200);
      expect(calls).toHaveLength(1);
    },
  );

  it("of someone Clerk calls org:member doesn't call Clerk", async () => {
    const team = newTeam();
    await me("user_founder", team, "admin");
    const calls: MembershipRoleChange[] = [];
    const { app: syncing } = testApp({
      publicPem,
      withTeam,
      clerkOrganizations: {
        setMembershipRole: async (change) => {
          calls.push(change);
          return "set";
        },
      },
    });
    const token = await sessionToken(key, "user_plain", 60, activeOrganization(team, "member"));

    expect(
      (await syncing.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    expect(calls).toEqual([]);
  });

  it("answers the Role Warden stored, not the token's", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [["user_lead", "lead"]]);

    expect((await me("user_lead", team, "member")).body).toEqual({
      userId: "user_lead",
      team,
      role: "lead",
      level: "quick",
    });
  });
});

describe("GET /api/me without an active Organization", () => {
  it("answers no Team and no Role, and never reaches the database", async () => {
    const teamsReached: string[] = [];
    const spied: WithTeam = (team, work) => {
      teamsReached.push(team);
      return withTeam(team, work);
    };
    const { app: spiedApp } = testApp({ publicPem, withTeam: spied });
    const token = await sessionToken(key, "user_solo");

    const res = await spiedApp.request("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user_solo",
      team: null,
      role: null,
      level: null,
    });
    expect(teamsReached).toEqual([]);
  });
});

describe("Team B and Team A", () => {
  it("withTeam(B) reads none of Team A's members or Role history", async () => {
    const a = newTeam();
    const b = newTeam();
    await me("user_a", a, "admin");
    await me("user_b", b, "admin");

    const seenByB = await stored(b);

    expect(seenByB.members).toEqual([{ user_id: "user_b", role: "admin" }]);
    expect(seenByB.history.map((row) => row.user_id)).toEqual(["user_b"]);
  });

  it("a Team B person's GET /api/me never answers their Team A Role", async () => {
    const a = newTeam();
    const b = newTeam();
    await seedTeam(withTeam, a, [["user_both", "admin"]]);
    await seedTeam(withTeam, b, [["user_b_admin", "admin"]]);

    expect((await me("user_both", b, "admin")).body).toEqual({
      userId: "user_both",
      team: b,
      role: "member",
      level: "quick",
    });
    expect((await me("user_both", a, "member")).body).toEqual({
      userId: "user_both",
      team: a,
      role: "admin",
      level: "quick",
    });
  });
});
