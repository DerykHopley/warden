// Story 1 at the API: opening Warden is what creates a Team (for its Clerk org:admin) or joins it (as a Member), and
// GET /api/me answers the person's Team and Role from Warden's own table (ADR 0008). Each case uses Teams of its own
// in the suite's shared database, read back through withTeam.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Hono } from "hono";
import type { Role } from "@warden/contracts";
import type { AppEnv } from "../src/app.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, sessionToken, testApp, testKey } from "./helpers.ts";

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

/** A Team that already exists, with these people in it. */
async function seedTeam(team: string, people: [userId: string, role: Role][]) {
  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    for (const [user_id, role] of people) {
      await tx.insertInto("team_members").values({ team_id: team, user_id, role }).execute();
    }
  });
}

describe("a Team's first visit", () => {
  it("by its Clerk org:admin creates the Team, with them as its Admin and one created_team row", async () => {
    const team = newTeam();

    expect(await me("user_founder", team, "admin")).toEqual({
      status: 200,
      body: { userId: "user_founder", team, role: "admin" },
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
        body: { userId: "user_founder", team, role: "admin" },
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
      body: { userId: "user_invited", team, role: "member" },
    });
    expect(await me("user_invited", team, "admin")).toEqual({
      status: 200,
      body: { userId: "user_invited", team, role: "member" },
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

  it("answers the Role Warden stored, not the token's", async () => {
    const team = newTeam();
    await seedTeam(team, [["user_lead", "lead"]]);

    expect((await me("user_lead", team, "member")).body).toEqual({
      userId: "user_lead",
      team,
      role: "lead",
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
    expect(await res.json()).toEqual({ userId: "user_solo", team: null, role: null });
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
    await seedTeam(a, [["user_both", "admin"]]);
    await seedTeam(b, [["user_b_admin", "admin"]]);

    expect((await me("user_both", b, "admin")).body).toEqual({
      userId: "user_both",
      team: b,
      role: "member",
    });
    expect((await me("user_both", a, "member")).body).toEqual({
      userId: "user_both",
      team: a,
      role: "admin",
    });
  });
});
