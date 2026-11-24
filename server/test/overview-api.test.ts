// GET /api/overview (story 10): the session's Team's Level and trend, for each Role, through the real app; never
// another Team's. Findings come from real Scans through the Findings module, in Teams of this file's own in the suite's
// shared database.
import { randomUUID } from "node:crypto";
import { OverviewBody, type Role, type Scan } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let app: Hono<AppEnv>;

beforeAll(async () => {
  const { privateKey, publicPem } = await testKey();
  key = privateKey;
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
  ({ app } = testApp({ publicPem, withTeam }));
});

afterAll(() => pool.end());

const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;

/** A Guard Scan of `repo` that sees one problem per path. */
const scan = (team: string, paths: string[]): Scan => ({
  id: `scan-${randomUUID()}`,
  team,
  module: "guard",
  started_at: "2026-11-24T09:00:00Z",
  assets: [repo],
  rules: ["guard/agent-can-read-env"],
  observations: paths.map((path) => ({
    asset: repo,
    rule_id: "guard/agent-can-read-env",
    location: { kind: "file", path },
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
  })),
});

/** A Team with one person at each Role, and Findings a Scan opened at `paths`. */
async function teamWithFindings(paths: string[]) {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    ["user_member", "member"],
    ["user_lead", "lead"],
    ["user_admin", "admin"],
  ]);
  await findings.reconcile(scan(team, paths));
  return team;
}

async function getOverview(headers: Record<string, string>) {
  const res = await app.request("/api/overview", { headers });
  return { status: res.status, body: await res.json() };
}

const as = async (userId: string, claims: Record<string, unknown>) => ({
  Authorization: `Bearer ${await sessionToken(key, userId, 60, claims)}`,
});

describe("GET /api/overview", () => {
  it.each<[Role, string]>([
    ["member", "user_member"],
    ["lead", "user_lead"],
    ["admin", "user_admin"],
  ])("answers a %s their Team's overview, at Quick", async (_role, userId) => {
    const team = await teamWithFindings([".claude/a.json", ".claude/b.json"]);

    const { status, body } = await getOverview(await as(userId, activeOrganization(team)));

    expect(status).toBe(200);
    expect(OverviewBody.parse(body)).toEqual({
      team,
      level: "quick",
      last_scan_at: "2026-11-24T09:00:00Z",
      period_days: 30,
      open_at_start: 0,
      open_now: 2,
      fix_rate: { fixed: 0, of: 2 },
    });
  });

  it("never counts another Team's Findings", async () => {
    const teamA = await teamWithFindings([".claude/a.json"]);
    const teamB = await teamWithFindings([".claude/b.json", ".claude/c.json", ".claude/d.json"]);

    const { body } = await getOverview(await as("user_member", activeOrganization(teamA)));

    const answered = OverviewBody.parse(body);
    expect(answered.team).toBe(teamA);
    expect(answered.open_now).toBe(1);
    expect(answered.fix_rate).toEqual({ fixed: 0, of: 1 });
    expect(JSON.stringify(body)).not.toContain(teamB);
  });

  it("answers 401 with no session", async () => {
    expect(await getOverview({})).toEqual({ status: 401, body: { error: "Not signed in" } });
  });

  it("answers 403 with no active Team", async () => {
    expect(await getOverview(await as("user_member", {}))).toEqual({
      status: 403,
      body: { error: "Choose a Team first" },
    });
  });

  it("answers 409 for a Team its Admin hasn't opened yet", async () => {
    const team = `org_${randomUUID()}`;
    expect(await getOverview(await as("user_member", activeOrganization(team)))).toEqual({
      status: 409,
      body: { error: "Your Team's Admin must open Warden first" },
    });
  });
});
