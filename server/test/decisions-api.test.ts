// Stories 3 and 4 at the API: a Lead accepts, marks a False positive, confirms a fix, marks a fix moved or reopens a
// Finding through the real app, as the person their session names, and a Member is refused each. Each case uses Teams
// of its own in the suite's shared database; Findings come from real Scans through the Findings module.
import { randomUUID } from "node:crypto";
import { Finding, HistoryBody, type Observation, type Role, type Scan } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
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
  findings = createFindings({
    withTeam,
    moveRules: { guard: guardMoveRule, patch: patchMoveRule },
  });
  ({ app } = testApp({ publicPem, withTeam }));
});

afterAll(async () => {
  await pool.end();
});

const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;
const ENV = "guard/agent-can-read-env";
const LEAD = "user_lead";
const MEMBER = "user_member";
const nextWeek = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

const observation = (path: string): Observation => ({
  asset: repo,
  rule_id: ENV,
  location: { kind: "file", path },
  severity: "high",
  title: "The agent can read .env files",
  evidence: { summary: "permissions.allow lets the agent read .env" },
});

const scan = (team: string, id: string, startedAt: string, paths: string[]): Scan => ({
  id,
  team,
  module: "guard",
  started_at: startedAt,
  assets: [repo],
  rules: [ENV],
  observations: paths.map(observation),
});

/** A Team with a Lead and a Member, and one Open Finding a Scan opened. */
async function teamWithFinding() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);
  await findings.reconcile(scan(team, "scan-1", "2026-11-24T09:00:00Z", [".claude/settings.json"]));
  const [finding] = await findings.list(team);
  return { team, finding: finding! };
}

/** As teamWithFinding, then a second Scan that sees the problem elsewhere: the Finding is an Unconfirmed fix. */
async function teamWithUnconfirmedFix() {
  const { team, finding } = await teamWithFinding();
  await findings.reconcile(
    scan(team, "scan-2", "2026-11-24T10:00:00Z", [".claude/settings.local.json"]),
  );
  const all = await findings.list(team);
  const old = all.find((f) => f.id === finding.id)!;
  const candidate = all.find((f) => f.id !== finding.id)!;
  expect(old).toMatchObject({ status: "fixed", unconfirmed_fix: { candidates: [candidate.id] } });
  return { team, old, candidate };
}

async function call(
  method: "GET" | "POST",
  path: string,
  { as, team, body }: { as: string; team: string; body?: unknown },
) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const post = (path: string, team: string, body: unknown, as = LEAD) =>
  call("POST", path, { as, team, body });
const history = (team: string, id: string, as = LEAD) =>
  call("GET", `/api/findings/${id}/history`, { as, team });

/** Everything stored for the Team's Findings, read as that Team. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    findings: await tx.selectFrom("findings").selectAll().orderBy("id").execute(),
    history: await tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
  }));
}

const byLead = (reason: string) => ({ cause: { kind: "person", id: LEAD }, reason });

describe("story 4: a Lead's decisions", () => {
  it("accepts an Open Finding, then reopens it; the history shows both, in order, naming the Lead", async () => {
    const { team, finding } = await teamWithFinding();
    const until = nextWeek();

    const accepted = await post(`/api/findings/${finding.id}/accept`, team, {
      reason: "Fixed next sprint",
      until,
    });
    const reopened = await post(`/api/findings/${finding.id}/reopen`, team, {
      reason: "The sprint slipped",
    });

    expect(accepted).toMatchObject({
      status: 200,
      body: { id: finding.id, status: "accepted", accepted_reason: "Fixed next sprint" },
    });
    expect(Date.parse(Finding.parse(accepted.body).accepted_until!)).toBe(Date.parse(until));
    expect(reopened).toMatchObject({
      status: 200,
      body: { id: finding.id, status: "open", accepted_reason: null, accepted_until: null },
    });
    const { status, body } = await history(team, finding.id);
    expect(status).toBe(200);
    expect(HistoryBody.parse(body).history.slice(1)).toEqual([
      expect.objectContaining({
        status_before: "open",
        status_after: "accepted",
        ...byLead("Fixed next sprint"),
      }),
      expect.objectContaining({
        status_before: "accepted",
        status_after: "open",
        ...byLead("The sprint slipped"),
      }),
    ]);
  });

  it("marks an Open Finding a False positive, then reopens it with a reason", async () => {
    const { team, finding } = await teamWithFinding();

    expect(
      await post(`/api/findings/${finding.id}/false-positive`, team, { reason: "A test fixture" }),
    ).toMatchObject({ status: 200, body: { id: finding.id, status: "false_positive" } });
    expect(
      await post(`/api/findings/${finding.id}/reopen`, team, { reason: "It ships after all" }),
    ).toMatchObject({ status: 200, body: { id: finding.id, status: "open" } });

    const { body } = await history(team, finding.id);
    expect(HistoryBody.parse(body).history.slice(1)).toEqual([
      expect.objectContaining({ status_after: "false_positive", ...byLead("A test fixture") }),
      expect.objectContaining({ status_after: "open", ...byLead("It ships after all") }),
    ]);
  });

  it("confirms a fix: the Unconfirmed fix is cleared, the Finding stays Fixed, the candidate stays Open", async () => {
    const { team, old, candidate } = await teamWithUnconfirmedFix();

    const confirmed = await post(`/api/findings/${old.id}/confirm-fix`, team, {
      reason: "The root settings were fixed",
    });

    expect(confirmed).toMatchObject({
      status: 200,
      body: { id: old.id, status: "fixed", unconfirmed_fix: null },
    });
    const after = await findings.list(team);
    expect(after.find((f) => f.id === candidate.id)).toEqual(candidate);
  });

  it("marks a fix moved: the old Finding reopens where the candidate was, and a later Scan matches it", async () => {
    const { team, old, candidate } = await teamWithUnconfirmedFix();
    const historyBefore = (await stored(team)).history.length;

    const moved = await post(`/api/findings/${old.id}/mark-moved`, team, {
      reason: "The permission moved to the local settings file",
      candidate: candidate.id,
    });

    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      id: old.id,
      status: "open",
      unconfirmed_fix: null,
      first_seen_scan: "scan-1",
      location: candidate.location,
      fingerprint: candidate.fingerprint,
      moved_to: null,
    });
    const merged = (await findings.list(team)).find((f) => f.id === candidate.id);
    expect(merged).toMatchObject({ status: "fixed", moved_to: old.id });
    const added = (await stored(team)).history.slice(historyBefore);
    expect(
      added.map((row) => [row.finding_id, row.status_before, row.status_after, row.actor_kind]),
    ).toEqual(
      expect.arrayContaining([
        [candidate.id, "open", "fixed", "person"],
        [old.id, "fixed", "open", "person"],
      ]),
    );
    expect(added).toHaveLength(2);
    expect(new Set(added.map((row) => row.actor_id))).toEqual(new Set([LEAD]));

    const later = await findings.reconcile(
      scan(team, "scan-3", "2026-11-24T11:00:00Z", [".claude/settings.local.json"]),
    );
    expect(later).toMatchObject({ opened: [], seen: [old.id], fixed: [] });
  });

  it("answers 409 with the refusal for a Status the call doesn't take, and writes nothing", async () => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);

    const refused = await post(`/api/findings/${finding.id}/reopen`, team, { reason: "Again" });

    expect(refused).toEqual({
      status: 409,
      body: { error: expect.stringMatching(/reopen refused: the Finding is open/) },
    });
    expect(await stored(team)).toEqual(before);
  });
});

describe("story 3: a Member and a Lead's decisions", () => {
  const routes: [string, Record<string, unknown>][] = [
    ["accept", { reason: "r", until: "2099-01-01T00:00:00Z" }],
    ["false-positive", { reason: "r" }],
    ["confirm-fix", { reason: "r" }],
    ["mark-moved", { reason: "r", candidate: "f-any" }],
    ["reopen", { reason: "r" }],
  ];

  it("a Member gets 403 on each decision, the Finding and its history unchanged, and reads the history", async () => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);

    for (const [route, body] of routes) {
      expect(await post(`/api/findings/${finding.id}/${route}`, team, body, MEMBER), route).toEqual(
        { status: 403, body: { error: "Your Role can't do this" } },
      );
    }

    expect(await stored(team)).toEqual(before);
    const read = await history(team, finding.id, MEMBER);
    expect(read.status).toBe(200);
    expect(HistoryBody.parse(read.body).history).toHaveLength(1);
  });
});

describe("a decision's bad input", () => {
  it.each([
    ["an until that isn't after now", "accept", { reason: "r", until: new Date().toISOString() }],
    ["a blank reason", "false-positive", { reason: "  \n " }],
    ["a 2,001-character reason", "false-positive", { reason: "x".repeat(2001) }],
    [
      "an actor in the body",
      "false-positive",
      { reason: "r", actor: { kind: "person", id: "user_someone_else" } },
    ],
    ["a body that isn't JSON", "false-positive", "reason=r"],
  ])("answers 400 for %s, and writes nothing", async (_name, route, body) => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);

    const answer = await post(`/api/findings/${finding.id}/${route}`, team, body);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: expect.any(String) });
    expect(await stored(team)).toEqual(before);
  });
});

describe("Team B and Team A's Finding", () => {
  it("Team B's Lead gets 404 deciding on it or reading its history, and Team A's rows are unchanged", async () => {
    const { team: a, finding } = await teamWithFinding();
    const b = `org_${randomUUID()}`;
    await seedTeam(withTeam, b, [[LEAD, "lead" satisfies Role]]);
    const before = await stored(a);

    expect(
      await post(`/api/findings/${finding.id}/accept`, b, { reason: "r", until: nextWeek() }),
    ).toEqual({ status: 404, body: { error: "No such Finding" } });
    expect(await history(b, finding.id)).toEqual({
      status: 404,
      body: { error: "No such Finding" },
    });

    expect(await stored(a)).toEqual(before);
    expect((await findings.list(a)).map((f: Finding) => f.status)).toEqual(["open"]);
  });
});
