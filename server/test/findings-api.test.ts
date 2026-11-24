// GET /api/findings (story 9): every Finding of the session's Team, for each Role, through the real app; never another
// Team's. Findings come from real Scans through the Findings module, in Teams of this file's own in the suite's
// shared database.
import { randomUUID } from "node:crypto";
import { FindingsBody, type Role, type Scan } from "@warden/contracts";
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

/** A Guard Scan of `repo` that sees one problem per path, with `title` on each. */
const scan = (team: string, title: string, paths: string[]): Scan => ({
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
    title,
    evidence: { summary: "permissions.allow lets the agent read .env" },
  })),
});

/** A Team with one person at each Role, and Findings a Scan opened at `paths`. */
async function teamWithFindings(title: string, paths: string[]) {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    ["user_member", "member"],
    ["user_lead", "lead"],
    ["user_admin", "admin"],
  ]);
  await findings.reconcile(scan(team, title, paths));
  return team;
}

async function getFindings(headers: Record<string, string>) {
  const res = await app.request("/api/findings", { headers });
  return { status: res.status, body: await res.json() };
}

const as = async (userId: string, claims: Record<string, unknown>) => ({
  Authorization: `Bearer ${await sessionToken(key, userId, 60, claims)}`,
});

describe("GET /api/findings", () => {
  it.each<[Role, string]>([
    ["member", "user_member"],
    ["lead", "user_lead"],
    ["admin", "user_admin"],
  ])("answers a %s every Finding of their Team", async (_role, userId) => {
    const team = await teamWithFindings("Team A's problem", [".claude/a.json", ".claude/b.json"]);

    const { status, body } = await getFindings(await as(userId, activeOrganization(team)));

    expect(status).toBe(200);
    const parsed = FindingsBody.parse(body);
    expect(parsed.findings).toEqual(await findings.list(team));
    expect(parsed.findings).toHaveLength(2);
  });

  it("never answers another Team's Findings", async () => {
    const teamA = await teamWithFindings("Team A's problem", [".claude/a.json"]);
    const teamB = await teamWithFindings("Team B's problem", [".claude/b.json", ".claude/c.json"]);

    const { body } = await getFindings(await as("user_member", activeOrganization(teamA)));

    const answered = FindingsBody.parse(body).findings;
    expect(answered.map((f) => f.team)).toEqual([teamA]);
    expect(answered.map((f) => f.title)).toEqual(["Team A's problem"]);
    expect(JSON.stringify(body)).not.toContain(teamB);
  });

  it("answers a Team with no Findings an empty list", async () => {
    const team = `org_${randomUUID()}`;
    await seedTeam(withTeam, team, [["user_member", "member"]]);

    const { status, body } = await getFindings(await as("user_member", activeOrganization(team)));

    expect(status).toBe(200);
    expect(body).toEqual({ findings: [] });
  });

  it("answers 401 with no session", async () => {
    expect(await getFindings({})).toEqual({ status: 401, body: { error: "Not signed in" } });
  });

  it("answers 403 with no active Team", async () => {
    expect(await getFindings(await as("user_member", {}))).toEqual({
      status: 403,
      body: { error: "Choose a Team first" },
    });
  });
});
