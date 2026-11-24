// Story 2 and story 3 (part) at the API: an Admin gives a person a Role through PUT /api/team/members/:userId/role,
// Clerk's org:admin kept in step when Admin is given or taken away (ADR 0008), and anyone in the Team lists its people
// with GET /api/team/members. A Team always keeps one Admin (threat A8). Clerk is a fake that records its calls; the
// database is the suite's real one, each case with Teams of its own.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it, onTestFinished } from "vitest";
import { Member, MembersBody, type Role } from "@warden/contracts";
import type { ClerkOrganizations, MembershipRoleChange } from "../src/members.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
});

afterAll(async () => {
  await pool.end();
});

/** A Clerk seam that records each call, and runs `then` after recording it (to throw, or to wait). */
function fakeClerk(then: (change: MembershipRoleChange) => Promise<void> = async () => {}) {
  const calls: MembershipRoleChange[] = [];
  const clerk: ClerkOrganizations = {
    setMembershipRole: async (change) => {
      calls.push(change);
      await then(change);
    },
  };
  return { calls, clerk };
}

/** A new Team with these people, and an app over it with `clerk` as its Clerk seam. */
async function teamWith(people: [string, Role][], clerk = fakeClerk()) {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, people);
  const { app, lines } = testApp({ publicPem, withTeam, clerkOrganizations: clerk.clerk });

  const headers = async (userId: string) => ({
    Authorization: `Bearer ${await sessionToken(key, userId, 60, activeOrganization(team))}`,
  });
  /** `body` is sent as JSON, or as it is when it's a string. */
  const put = async (actor: string, userId: string, body: unknown) => {
    const res = await app.request(`/api/team/members/${userId}/role`, {
      method: "PUT",
      headers: { ...(await headers(actor)), "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const list = async (actor: string) => {
    const res = await app.request("/api/team/members", { headers: await headers(actor) });
    return { status: res.status, body: await res.json() };
  };
  return { team, put, list, calls: clerk.calls, lines };
}

/** The Team's Roles and Role history, read as that Team. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
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

const changed = (user_id: string, role_before: Role, role_after: Role, actor_id: string) => ({
  user_id,
  role_before,
  role_after,
  change: "changed",
  actor_id,
});

describe("PUT /api/team/members/:userId/role", () => {
  it("story 2: an Admin makes a Member a Lead, with one changed history row and no call to Clerk", async () => {
    const { team, put, calls } = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    const answer = await put("user_admin", "user_member", { role: "lead" });

    expect(answer.status).toBe(200);
    expect(Member.parse(answer.body)).toMatchObject({ userId: "user_member", role: "lead" });
    expect(await stored(team)).toEqual({
      members: [
        { user_id: "user_admin", role: "admin" },
        { user_id: "user_member", role: "lead" },
      ],
      history: [changed("user_member", "member", "lead", "user_admin")],
    });
    expect(calls).toEqual([]);
  });

  it("making someone Admin gives them org:admin in Clerk, and taking Admin away gives org:member", async () => {
    const { team, put, calls } = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    expect((await put("user_admin", "user_member", { role: "admin" })).status).toBe(200);
    expect(calls).toEqual([{ organizationId: team, userId: "user_member", role: "org:admin" }]);

    expect((await put("user_admin", "user_member", { role: "lead" })).status).toBe(200);
    expect(calls).toEqual([
      { organizationId: team, userId: "user_member", role: "org:admin" },
      { organizationId: team, userId: "user_member", role: "org:member" },
    ]);
    expect((await stored(team)).history).toEqual([
      changed("user_member", "member", "admin", "user_admin"),
      changed("user_member", "admin", "lead", "user_admin"),
    ]);
  });

  it("answers 502 when Clerk refuses, changes nothing, and logs the error with no secret in it", async () => {
    const { team, put, calls, lines } = await teamWith(
      [
        ["user_admin", "admin"],
        ["user_member", "member"],
      ],
      fakeClerk(async () => {
        throw new Error("Clerk said no to sk_live_abcdef123456");
      }),
    );

    expect(await put("user_admin", "user_member", { role: "admin" })).toEqual({
      status: 502,
      body: { error: "Clerk didn't take the change; nothing changed" },
    });
    expect(calls).toHaveLength(1);
    expect(await stored(team)).toEqual({
      members: [
        { user_id: "user_admin", role: "admin" },
        { user_id: "user_member", role: "member" },
      ],
      history: [],
    });
    const logged = lines.find((line) => line.includes("Clerk said no"));
    expect(logged).toBeDefined();
    expect(logged).not.toContain("abcdef123456");
  });

  it("refuses the last Admin demoting themselves with 409: nothing written, Clerk not called", async () => {
    const { team, put, calls } = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    expect(await put("user_admin", "user_admin", { role: "lead" })).toEqual({
      status: 409,
      body: { error: "A Team needs at least one Admin" },
    });
    expect((await stored(team)).members).toContainEqual({ user_id: "user_admin", role: "admin" });
    expect((await stored(team)).history).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("lets only one of two Admins demoting each other at once through: the other gets 409", async () => {
    const lockKey = (team: string) => `team_members:${team}`;
    // The first change holds the Team's lock while Clerk is called; it waits there until the second is queued
    // behind that lock, so both have passed requireRole as Admins before either commits. The check has a pool of its
    // own, as the two changes hold both of the app's connections.
    let team = "";
    const probe = poolAs("warden_app", inject("testDatabase"));
    onTestFinished(() => probe.end());
    const queuedBehind = async () => {
      for (let tries = 0; tries < 100; tries++) {
        const { rows } = await probe.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
            where locktype = 'advisory' and not granted and objsubid = 1
              and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
          [lockKey(team)],
        );
        if (rows[0]!.waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the second change never queued behind the Team's lock");
    };
    const clerk = fakeClerk(queuedBehind);
    const setup = await teamWith(
      [
        ["user_a", "admin"],
        ["user_b", "admin"],
      ],
      clerk,
    );
    team = setup.team;

    const answers = await Promise.all([
      setup.put("user_a", "user_b", { role: "member" }),
      setup.put("user_b", "user_a", { role: "member" }),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const { members, history } = await stored(team);
    expect(members.filter((member) => member.role === "admin")).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(history[0]!.change).toBe("changed");
    expect(clerk.calls).toHaveLength(1);
  });

  it("answers 200 for a person's current Role, with no history row and no call to Clerk", async () => {
    const { team, put, calls } = await teamWith([
      ["user_admin", "admin"],
      ["user_lead", "lead"],
    ]);

    const answer = await put("user_admin", "user_lead", { role: "lead" });

    expect(answer.status).toBe(200);
    expect(Member.parse(answer.body)).toMatchObject({ userId: "user_lead", role: "lead" });
    expect((await stored(team)).history).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("answers 404 for a user id that isn't in the Team", async () => {
    const { team, put, calls } = await teamWith([["user_admin", "admin"]]);

    expect(await put("user_admin", "user_nobody", { role: "lead" })).toEqual({
      status: 404,
      body: { error: "No such member" },
    });
    expect((await stored(team)).history).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a role outside the three", { role: "owner" }],
    ["a body that isn't JSON", "role=admin"],
  ])("answers 400 for %s, and writes nothing", async (_name, body) => {
    const { team, put, calls } = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    const answer = await put("user_admin", "user_member", body);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: expect.any(String) });
    expect(await stored(team)).toEqual({
      members: [
        { user_id: "user_admin", role: "admin" },
        { user_id: "user_member", role: "member" },
      ],
      history: [],
    });
    expect(calls).toEqual([]);
  });

  it.each(["user_member", "user_lead"])(
    "story 3: refuses %s with 403, and nothing changes",
    async (actor) => {
      const { team, put, calls } = await teamWith([
        ["user_admin", "admin"],
        ["user_lead", "lead"],
        ["user_member", "member"],
      ]);
      const before = await stored(team);

      expect(await put(actor, "user_member", { role: "admin" })).toEqual({
        status: 403,
        body: { error: "Your Role can't do this" },
      });
      expect(await stored(team)).toEqual(before);
      expect(calls).toEqual([]);
    },
  );
});

describe("GET /api/team/members", () => {
  it("story 3: answers a Member with every person in the Team", async () => {
    const { list } = await teamWith([
      ["user_admin", "admin"],
      ["user_lead", "lead"],
      ["user_member", "member"],
    ]);

    const answer = await list("user_member");

    expect(answer.status).toBe(200);
    const body = MembersBody.parse(answer.body);
    expect(body.members.map(({ userId, role }) => [userId, role])).toEqual([
      ["user_admin", "admin"],
      ["user_lead", "lead"],
      ["user_member", "member"],
    ]);
  });
});

describe("Team B and Team A", () => {
  it("Team B's list holds only Team B, and its Admin's PUT naming a Team A person answers 404", async () => {
    const a = await teamWith([
      ["user_a_admin", "admin"],
      ["user_a_member", "member"],
    ]);
    const b = await teamWith([
      ["user_b_admin", "admin"],
      ["user_b_member", "member"],
    ]);
    const teamABefore = await stored(a.team);

    const listed = MembersBody.parse((await b.list("user_b_admin")).body);
    expect(listed.members.map((member) => member.userId)).toEqual([
      "user_b_admin",
      "user_b_member",
    ]);

    expect(await b.put("user_b_admin", "user_a_member", { role: "admin" })).toEqual({
      status: 404,
      body: { error: "No such member" },
    });
    expect(await stored(a.team)).toEqual(teamABefore);
    expect(b.calls).toEqual([]);
  });
});
