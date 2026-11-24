// Story 3 (part): requireRole lets a person through only with a Role at least the one a route needs, read from
// Warden's own table, never the token (ADR 0008, threat A4). Throwaway routes are mounted behind the real app's
// middleware; the decisions that will use it are slice 8's.
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
let otherKey: CryptoKey;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;
const team = `org_roles_${randomUUID()}`;

beforeAll(async () => {
  let publicPem: string;
  ({ privateKey: key, publicPem } = await testKey());
  ({ privateKey: otherKey } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({
    publicPem,
    withTeam,
    mount: (api, requireRole) => {
      for (const role of ["member", "lead", "admin"] as const) {
        api.post(`/api/test/needs-${role}`, requireRole(role), (c) =>
          c.json({ userId: c.get("session").userId, team: c.get("team"), role: c.get("role") }),
        );
      }
    },
  }));
  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    for (const role of ["member", "lead", "admin"] as const) {
      await tx
        .insertInto("team_members")
        .values({ team_id: team, user_id: `user_${role}`, role })
        .execute();
    }
  });
});

afterAll(async () => {
  await pool.end();
});

async function post(path: string, token: string | undefined) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await app.request(path, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

const tokenFor = (userId: string, clerkRole: "admin" | "member" = "member") =>
  sessionToken(key, userId, 60, activeOrganization(team, clerkRole));

const refused = { status: 403, body: { error: "Your Role can't do this" } };
const through = (role: Role) => ({
  status: 200,
  body: { userId: `user_${role}`, team, role },
});

describe("requireRole", () => {
  it.each([
    ["member", "member", true],
    ["lead", "member", false],
    ["lead", "lead", true],
    ["lead", "admin", true],
    ["admin", "lead", false],
    ["admin", "admin", true],
  ] as const)("needing %s, with a stored %s, lets them through: %s", async (needs, has, ok) => {
    expect(await post(`/api/test/needs-${needs}`, await tokenFor(`user_${has}`))).toEqual(
      ok ? through(has) : refused,
    );
  });

  it("reads the Role from Warden's table: a stored Member whose token says org:admin is refused a Lead's route", async () => {
    expect(await post("/api/test/needs-lead", await tokenFor("user_member", "admin"))).toEqual(
      refused,
    );
  });

  it("refuses a token with no active Organization with 403 'Choose a Team first'", async () => {
    expect(await post("/api/test/needs-member", await sessionToken(key, "user_member"))).toEqual({
      status: 403,
      body: { error: "Choose a Team first" },
    });
  });

  it.each([
    ["no token", async () => undefined],
    ["a token signed by another key", () => sessionToken(otherKey, "user_admin")],
  ])("refuses %s with 401", async (_name, token) => {
    expect(await post("/api/test/needs-member", await token())).toEqual({
      status: 401,
      body: { error: "Not signed in" },
    });
  });

  it("runs the first-use steps: a new Team's first visitor who isn't org:admin gets the 409", async () => {
    const token = await sessionToken(key, "user_x", 60, activeOrganization(`org_${randomUUID()}`));
    expect(await post("/api/test/needs-member", token)).toEqual({
      status: 409,
      body: { error: "Your Team's Admin must open Warden first" },
    });
  });

  it("runs the first-use steps: an invited person joins as a Member and gets a Member's routes only", async () => {
    const token = await sessionToken(key, "user_new", 60, activeOrganization(team, "admin"));
    expect(await post("/api/test/needs-member", token)).toEqual({
      status: 200,
      body: { userId: "user_new", team, role: "member" },
    });
    expect(await post("/api/test/needs-lead", token)).toEqual(refused);
  });
});
