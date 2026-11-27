// GET /api/overview (story 10, and spec #341's stories 8 and 9): the session's Team's Level, trend and Vouch's answer to
// "Are we ready for the audit?", for each Role, through the real app with Vouch wired as the start-up file wires it;
// never another Team's. Findings come from real Scans through the Findings module, Catalogue switches and reviews through
// Vouch's own routes, in Teams of this file's own in the suite's shared database.
import { randomUUID } from "node:crypto";
import {
  ControlsBody,
  MeBody,
  OverviewBody,
  type Asset,
  type AuditControl,
  type Observation,
  type ReviewBody,
  type Role,
  type RuleId,
  type Scan,
} from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv, AuditReads } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  call,
  linkRepos,
  NO_CATALOGUE,
  repoRef,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
  vouchWiring,
} from "./helpers.ts";

const LEAD = "user_lead";
const MEMBER = "user_member";
const ISA = "vda-isa-2027.1";
const CONTROLS = `/api/vouch/catalogues/${ISA}/controls`;

const DAY = 24 * 3600_000;
const START = Math.floor(Date.now() / 1000) * 1000;
/** A whole-second time `days` before the test file started. */
const daysAgo = (days: number) => new Date(START - days * DAY);

const UNAPPROVED: RuleId = "guard/unapproved-ai-tool";
const MCP: RuleId = "guard/mcp-server-unpinned";
const SECRET: RuleId = "guard/secret-in-repo";
const SETTINGS: RuleId = "guard/secret-in-agent-settings";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let repoAssets: RepoAssets;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
  repoAssets = createRepoAssets({ withTeam });
  const vouch = vouchWiring(withTeam);
  ({ app } = testApp({ publicPem, withTeam, moduleRoutes: [vouch.routes], audit: vouch.audit }));
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
      audit: NO_CATALOGUE,
      last_scan_at: "2026-11-24T09:00:00Z",
      has_findings: true,
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

// Vouch's answer and the Level (spec #341, slice 4).

const appRepo: Asset = { kind: "repo", ref: repoRef("app") };
const apiRepo: Asset = { kind: "repo", ref: repoRef("api") };

/** A Team with an Admin, a Lead and a Member. */
async function vouchTeam() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);
  return team;
}

/** The Team's Admin turns ISA2027 on or off. */
async function setIsa(team: string, on: boolean) {
  const res = await call(app, key, "PUT", `/api/vouch/catalogues/${ISA}`, {
    as: ADMIN,
    teamId: team,
    body: { on },
  });
  expect(res.status).toBe(200);
}

/** The Team's Lead reviews Control `ref` of ISA2027. */
async function review(team: string, ref: string, body: ReviewBody) {
  const res = await call(app, key, "POST", `${CONTROLS}/${ref}/reviews`, {
    as: LEAD,
    teamId: team,
    body,
  });
  expect(res.status).toBe(201);
}

const confirm = (team: string, ref: string) => review(team, ref, { outcome: "confirm" });

/** `GET /api/overview` as `who`, parsed, with its text. */
async function overviewOf(team: string, who = MEMBER) {
  const res = await call(app, key, "GET", "/api/overview", { as: who, teamId: team });
  expect(res.status).toBe(200);
  return { body: OverviewBody.parse(res.body), text: res.text };
}

/** `GET /api/me`'s Level as `who`. */
async function meLevel(team: string, who = MEMBER) {
  const res = await call(app, key, "GET", "/api/me", { as: who, teamId: team });
  expect(res.status).toBe(200);
  return MeBody.parse(res.body).level;
}

/** `GET /api/vouch/catalogues/vda-isa-2027.1/controls`, parsed, with its text. */
async function controlsOf(team: string) {
  const res = await call(app, key, "GET", CONTROLS, { as: MEMBER, teamId: team });
  expect(res.status).toBe(200);
  return { body: ControlsBody.parse(res.body), text: res.text };
}

const row = (controls: readonly AuditControl[], ref: string) => {
  const found = controls.find((control) => control.ref === ref);
  if (found === undefined) throw new Error(`the Overview has no row for ${ref}`);
  return found;
};

let titles = 0;
const observation = (asset: Asset, rule_id: RuleId): Observation => ({
  asset,
  rule_id,
  location: { kind: "file", path: `.claude/${randomUUID()}.json` },
  severity: "high",
  title: `A problem the test made, number ${++titles}`,
  evidence: { summary: "written by the test" },
});

const guardScan = (
  team: string,
  days: number,
  assets: Asset[],
  rules: RuleId[],
  observations: Observation[] = [],
): Scan => ({
  id: `scan-${randomUUID()}`,
  team,
  module: "guard",
  started_at: daysAgo(days).toISOString(),
  assets,
  rules,
  observations,
});

/**
 * A Team with ISA2027 on, holding Repos app and api. A Guard Scan two days ago covered both for 1.3.3's and 4.1.3's
 * Rules and found one secret in app's repo, still Open. So 1.3.3 is evidenced, 4.1.3 partly, and 1.3.4 (no Scan
 * covered its Rules) and 5.2.4 (no Judge Spot run) not evidenced. Nothing is reviewed.
 */
async function seededTeam() {
  const team = await vouchTeam();
  await linkRepos(repoAssets, team, [appRepo.ref, apiRepo.ref]);
  await findings.reconcile(
    guardScan(
      team,
      2,
      [appRepo, apiRepo],
      [UNAPPROVED, MCP, SECRET, SETTINGS],
      [observation(appRepo, SECRET)],
    ),
  );
  await setIsa(team, true);
  return team;
}

/** `seededTeam`, with its Lead's confirms of a not evidenced 5.2.4 and a partly evidenced 4.1.3: two Gaps. */
async function teamWithGaps() {
  const team = await seededTeam();
  await confirm(team, "5.2.4");
  await confirm(team, "4.1.3");
  return team;
}

/**
 * `teamWithGaps`, then a Scan a day ago covering 4.1.3's Rules on both Repos with nothing found (so app's secret is no
 * longer Open), and every Control reviewed with no Gap: 4.1.3 confirmed at evidenced, 5.2.4 overridden to not
 * applicable, 1.3.3 confirmed at evidenced and 1.3.4 overridden to evidenced.
 */
async function readyTeam() {
  const team = await teamWithGaps();
  await findings.reconcile(guardScan(team, 1, [appRepo, apiRepo], [SECRET, SETTINGS]));
  await confirm(team, "4.1.3");
  await review(team, "5.2.4", {
    outcome: "override",
    verdict: "not_applicable",
    reason: "No AI agent of ours is used in production yet.",
  });
  await confirm(team, "1.3.3");
  await review(team, "1.3.4", {
    outcome: "override",
    verdict: "evidenced",
    reason: "Our own runbook covers agent permissions; the auditor has seen it.",
  });
  return team;
}

describe("GET /api/overview: Are we ready for the audit?", () => {
  it("answers no Catalogue, at Quick, when ISA2027 was never set and when it was set off after reviews", async () => {
    const neverSet = await vouchTeam();
    const turnedOff = await readyTeam();
    await setIsa(turnedOff, false);

    for (const team of [neverSet, turnedOff]) {
      const { body } = await overviewOf(team);
      expect(body.audit).toEqual({ answer: "no_catalogue", gaps: 0, waiting: 0, controls: [] });
      expect(body.level).toBe("quick");
    }
  });

  it("answers not yet with every Control waiting when ISA2027 is on and nothing is reviewed, each row as the Controls read has it", async () => {
    const team = await seededTeam();

    const { body } = await overviewOf(team);
    const controls = (await controlsOf(team)).body.controls;

    expect(body.audit.answer).toBe("not_yet");
    expect(body.audit.gaps).toBe(0);
    expect(body.audit.waiting).toBe(4);
    expect(body.audit.controls.map(({ ref }) => ref)).toEqual(["1.3.3", "1.3.4", "4.1.3", "5.2.4"]);
    expect(body.audit.controls).toEqual(
      controls.map(({ ref, question, verdict }) => ({
        catalogue: ISA,
        ref,
        question,
        verdict,
        review_state: "not_reviewed",
        reviewed_verdict: null,
        gap: false,
      })),
    );
    expect(body.audit.controls.map(({ verdict }) => verdict)).toEqual([
      "evidenced",
      "not_evidenced",
      "partly_evidenced",
      "not_evidenced",
    ]);
  });

  it("counts a Control a Lead confirmed at not evidenced or partly evidenced as a Gap", async () => {
    const team = await teamWithGaps();

    const { audit } = (await overviewOf(team)).body;

    expect(row(audit.controls, "5.2.4")).toMatchObject({
      review_state: "reviewed",
      reviewed_verdict: "not_evidenced",
      gap: true,
    });
    expect(row(audit.controls, "4.1.3")).toMatchObject({
      review_state: "reviewed",
      reviewed_verdict: "partly_evidenced",
      gap: true,
    });
    expect(audit.gaps).toBe(2);
    expect(audit.waiting).toBe(2);
    expect(audit.answer).toBe("not_yet");
  });

  it("answers yes once every Control is reviewed with no Gap", async () => {
    const team = await readyTeam();

    const { audit } = (await overviewOf(team)).body;

    expect(audit.answer).toBe("yes");
    expect(audit.gaps).toBe(0);
    expect(audit.waiting).toBe(0);
    expect(
      audit.controls.map(({ ref, reviewed_verdict, gap }) => [ref, reviewed_verdict, gap]),
    ).toEqual([
      ["1.3.3", "evidenced", false],
      ["1.3.4", "evidenced", false],
      ["4.1.3", "evidenced", false],
      ["5.2.4", "not_applicable", false],
    ]);
  });

  it("waits again on a reviewed Control whose Verdict changed, while the Level stays Audit-ready", async () => {
    const team = await readyTeam();
    await findings.reconcile(
      guardScan(team, 0, [appRepo], [UNAPPROVED], [observation(appRepo, UNAPPROVED)]),
    );

    const { body } = await overviewOf(team);

    expect(row(body.audit.controls, "1.3.3")).toMatchObject({
      verdict: "partly_evidenced",
      review_state: "changed_since_review",
      gap: false,
    });
    expect(body.audit.waiting).toBe(1);
    expect(body.audit.gaps).toBe(0);
    expect(body.audit.answer).toBe("not_yet");
    expect(body.level).toBe("audit_ready");
    expect(await meLevel(team)).toBe("audit_ready");
  });

  it("makes no Gap of an Open Finding on a Repo the Team doesn't hold, and shows it nowhere (#358)", async () => {
    const team = await vouchTeam();
    const a: Asset = { kind: "repo", ref: repoRef("a") };
    const b: Asset = { kind: "repo", ref: repoRef("b") };
    await linkRepos(repoAssets, team, [a.ref]);
    await findings.reconcile(
      guardScan(team, 1, [a, b], [SECRET, SETTINGS], [observation(b, SECRET)]),
    );
    const [onB] = await findings.list(team);
    if (onB === undefined) throw new Error("the Scan opened no Finding on b");
    await setIsa(team, true);
    await confirm(team, "4.1.3");

    const overview = await overviewOf(team);
    const controls = await controlsOf(team);

    const isa413 = row(overview.body.audit.controls, "4.1.3");
    expect(isa413.verdict).toBe(controls.body.controls.find(({ ref }) => ref === "4.1.3")?.verdict);
    expect(isa413).toMatchObject({
      verdict: "evidenced",
      reviewed_verdict: "evidenced",
      gap: false,
    });
    expect(overview.body.audit.gaps).toBe(0);
    expect(overview.text).not.toContain(onB.id);
    expect(controls.text).not.toContain(onB.id);
  });

  it("raises the Level to Audit-ready once all four Controls have a review, Gaps among them, and back to Quick when ISA2027 is off", async () => {
    const team = await seededTeam();
    await confirm(team, "1.3.3");
    await confirm(team, "1.3.4");
    await confirm(team, "4.1.3");

    expect((await overviewOf(team)).body.level).toBe("quick");
    expect(await meLevel(team)).toBe("quick");

    await confirm(team, "5.2.4");

    const { body } = await overviewOf(team);
    expect(body.audit.gaps).toBeGreaterThan(0);
    expect(body.level).toBe("audit_ready");
    expect(await meLevel(team)).toBe("audit_ready");

    await setIsa(team, false);

    expect((await overviewOf(team)).body.level).toBe("quick");
    expect(await meLevel(team)).toBe("quick");
  });

  it("never shows another Team's Catalogue or reviews", async () => {
    const teamA = await readyTeam();
    const teamB = await vouchTeam();

    const off = await overviewOf(teamB);
    expect(off.body.audit).toEqual(NO_CATALOGUE);
    expect(off.body.level).toBe("quick");

    await setIsa(teamB, true);

    const on = await overviewOf(teamB);
    expect(on.body.audit.controls.map(({ review_state }) => review_state)).toEqual([
      "not_reviewed",
      "not_reviewed",
      "not_reviewed",
      "not_reviewed",
    ]);
    expect(on.body.level).toBe("quick");
    expect((await overviewOf(teamA)).body.audit.answer).toBe("yes");
  });

  it("answers a Member, a Lead and an Admin the same answer and Level", async () => {
    const team = await teamWithGaps();

    const answers = await Promise.all(
      [MEMBER, LEAD, ADMIN].map(async (who) => {
        const { audit, level } = (await overviewOf(team, who)).body;
        return { audit, level };
      }),
    );

    expect(answers[0]?.audit.gaps).toBe(2);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });
});

describe("a Vouch read that throws", () => {
  const failed = () => Promise.reject(new Error("the test's Vouch read failed"));

  // Each route fails on the one read it makes: the Overview's Level comes from its answer, `/api/me`'s from auditReady.
  it.each<[string, AuditReads]>([
    ["/api/overview", { answer: failed, auditReady: async () => false }],
    ["/api/me", { answer: async () => NO_CATALOGUE, auditReady: failed }],
  ])("makes %s answer the logged 500", async (path, audit) => {
    const failing = testApp({ publicPem, withTeam, audit });
    const team = await vouchTeam();

    const res = await call(failing.app, key, "GET", path, { as: MEMBER, teamId: team });

    expect(res).toMatchObject({ status: 500, body: { error: "Internal server error" } });
    expect(failing.lines.join("\n")).toContain("the test's Vouch read failed");
  });
});
