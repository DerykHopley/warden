// Story 4's Proposal part at the API: a Member proposes, a Lead approves or rejects, and the Proposal keeps who asked
// and who decided (ADR 0008). Through the real app, as the person each session names; each case uses Teams of its own
// in the suite's shared database, with Findings from real Scans through the Findings module.
import { randomUUID } from "node:crypto";
import {
  HistoryBody,
  Proposal,
  ProposalsBody,
  type Observation,
  type Scan,
} from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { activeOrganization, seedTeam, sessionToken, testApp, testKey } from "./helpers.ts";

let key: CryptoKey;
let pool: pg.Pool;
/** Its own pool, to hold a Team's Findings lock and read pg_locks while the app's connections wait. */
let probe: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let app: Hono<AppEnv>;

beforeAll(async () => {
  const { privateKey, publicPem } = await testKey();
  key = privateKey;
  pool = poolAs("warden_app", inject("testDatabase"));
  probe = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: { guard: guardMoveRule } });
  ({ app } = testApp({ publicPem, withTeam }));
});

afterAll(async () => {
  await pool.end();
  await probe.end();
});

const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;
const ENV = "guard/agent-can-read-env";
const LEAD = "user_lead";
const OTHER_LEAD = "user_other_lead";
const MEMBER = "user_member";
const ADMIN = "user_admin";
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

/** A Team with an Admin, two Leads and a Member, and one Open Finding a Scan opened. */
async function teamWithFinding() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [OTHER_LEAD, "lead"],
    [MEMBER, "member"],
  ]);
  await findings.reconcile(scan(team, "scan-1", "2026-11-24T09:00:00Z", [".claude/settings.json"]));
  const [finding] = await findings.list(team);
  return { team, finding: finding! };
}

async function post(
  path: string,
  {
    as,
    team,
    body,
    method = "POST",
  }: { as: string; team: string; body?: unknown; method?: string },
) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const propose = (team: string, findingId: string, body: unknown, as = MEMBER) =>
  post(`/api/findings/${findingId}/proposals`, { as, team, body });
const approve = (team: string, proposalId: string, as = LEAD) =>
  post(`/api/proposals/${proposalId}/approve`, { as, team });
const reject = (team: string, proposalId: string, body: unknown, as = LEAD) =>
  post(`/api/proposals/${proposalId}/reject`, { as, team, body });

/** Everything stored for the Team's Findings and Proposals, read as that Team. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    findings: await tx.selectFrom("findings").selectAll().orderBy("id").execute(),
    history: await tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
    proposals: await tx.selectFrom("proposals").selectAll().orderBy("id").execute(),
  }));
}

/** A Member's pending Proposal to mark the Team's Finding a False positive. */
async function pendingProposal() {
  const { team, finding } = await teamWithFinding();
  const proposed = await propose(team, finding.id, {
    decision: "mark_false_positive",
    reason: "The file is a test fixture",
  });
  expect(proposed.status).toBe(201);
  return { team, finding, proposal: Proposal.parse(proposed.body) };
}

describe("story 4: a Member proposes, a Lead approves", () => {
  it("the Proposal keeps who asked and who approved, and the history row names both", async () => {
    const { team, finding } = await teamWithFinding();
    const until = nextWeek();
    const before = await stored(team);

    const proposed = await propose(team, finding.id, {
      decision: "accept",
      reason: "Fixed next sprint",
      until,
    });

    expect(proposed.status).toBe(201);
    const proposal = Proposal.parse(proposed.body);
    expect(proposal).toMatchObject({
      finding_id: finding.id,
      decision: "accept",
      state: "pending",
      requested_by: { kind: "person", id: MEMBER },
      decided_by: null,
    });
    expect(Date.parse(proposal.until!)).toBe(Date.parse(until));
    const afterProposing = await stored(team);
    expect(afterProposing.findings).toEqual(before.findings);
    expect(afterProposing.history).toEqual(before.history);

    const approved = await approve(team, proposal.id);

    expect(approved.status).toBe(200);
    expect(Proposal.parse(approved.body)).toMatchObject({
      id: proposal.id,
      state: "approved",
      requested_by: { kind: "person", id: MEMBER },
      decided_by: LEAD,
    });
    expect((await findings.list(team))[0]).toMatchObject({
      status: "accepted",
      accepted_reason: "Fixed next sprint",
    });
    const history = await post(`/api/findings/${finding.id}/history`, {
      as: MEMBER,
      team,
      method: "GET",
    });
    expect(history.status).toBe(200);
    expect(HistoryBody.parse(history.body).history.at(-1)).toMatchObject({
      status_before: "open",
      status_after: "accepted",
      cause: { kind: "person", id: LEAD },
      proposal: { id: proposal.id, requested_by: { kind: "person", id: MEMBER } },
    });
    expect((await stored(team)).proposals).toMatchObject([
      { id: proposal.id, state: "approved", decided_by: LEAD },
    ]);
  });
});

describe("a second Proposal while one is pending", () => {
  it("a Member proposing twice on one Finding gets 409 in plain words, and no row is written", async () => {
    const { team, finding } = await pendingProposal();
    const before = await stored(team);
    expect(before.proposals).toHaveLength(1);

    const answer = await propose(team, finding.id, {
      decision: "accept",
      reason: "Fixed next sprint",
      until: nextWeek(),
    });

    expect(answer).toEqual({
      status: 409,
      body: { error: "This Finding already has a Proposal waiting for a Lead or Admin to decide." },
    });
    expect(await stored(team)).toEqual(before);
  });
});

describe("a Lead's reject", () => {
  it("leaves the Finding unchanged, rejects the Proposal with the reason, writes no history; again answers 409", async () => {
    const { team, proposal } = await pendingProposal();
    const before = await stored(team);

    const rejected = await reject(team, proposal.id, { reason: "Fix it this sprint" });

    expect(rejected.status).toBe(200);
    expect(Proposal.parse(rejected.body)).toMatchObject({
      state: "rejected",
      decided_by: LEAD,
      decided_reason: "Fix it this sprint",
    });
    const after = await stored(team);
    expect(after.findings).toEqual(before.findings);
    expect(after.history).toEqual(before.history);

    const again = { status: 409, body: { error: expect.any(String) } };
    expect(await approve(team, proposal.id)).toEqual(again);
    expect(await reject(team, proposal.id, { reason: "Again" })).toEqual(again);
    expect(await stored(team)).toEqual(after);
  });
});

describe("two Leads approving one Proposal at once", () => {
  it("one gets 200, the other 409, and one history row is written", async () => {
    const { team, proposal } = await pendingProposal();
    const historyBefore = (await stored(team)).history.length;

    const answers = await Promise.all([
      approve(team, proposal.id, LEAD),
      approve(team, proposal.id, OTHER_LEAD),
    ]);

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect((await stored(team)).history).toHaveLength(historyBefore + 1);
  });
});

/** Resolves once a transaction is waiting for `team`'s Findings lock. */
async function queuedBehindFindingsLock(team: string) {
  for (let tries = 0; tries < 100; tries++) {
    const { rows } = await probe.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_locks
        where locktype = 'advisory' and not granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [team],
    );
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the approve never queued behind the Team's Findings lock");
}

describe("a Lead demoted while their approve waits on the lock", () => {
  it("gets 403, and the Proposal stays pending", async () => {
    const { team, proposal } = await pendingProposal();
    const holder = await probe.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [team]);

      const approving = approve(team, proposal.id);
      await queuedBehindFindingsLock(team);
      await withTeam(team, (tx) =>
        tx
          .updateTable("team_members")
          .set({ role: "member" })
          .where("user_id", "=", LEAD)
          .execute(),
      );
      const before = await stored(team);
      await holder.query("commit");

      expect(await approving).toEqual({ status: 403, body: { error: "Your Role can't do this" } });
      expect(await stored(team)).toEqual(before);
      expect(before.proposals).toMatchObject([{ state: "pending" }]);
    } finally {
      holder.release();
    }
  });
});

describe("a Member", () => {
  it("gets 403 on approve and reject, and the Proposal is unchanged", async () => {
    const { team, proposal } = await pendingProposal();
    const before = await stored(team);

    expect(await approve(team, proposal.id, MEMBER)).toEqual({
      status: 403,
      body: { error: "Your Role can't do this" },
    });
    expect(await reject(team, proposal.id, { reason: "r" }, MEMBER)).toEqual({
      status: 403,
      body: { error: "Your Role can't do this" },
    });

    expect(await stored(team)).toEqual(before);
  });
});

describe("Team B and Team A's Proposal and Finding", () => {
  it("Team B's Lead approving or rejecting gets 404, and Team B's Member proposing gets 404", async () => {
    const { finding, proposal } = await pendingProposal();
    const b = `org_${randomUUID()}`;
    await seedTeam(withTeam, b, [
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);

    expect(await approve(b, proposal.id)).toEqual({
      status: 404,
      body: { error: "No such Proposal" },
    });
    expect(await reject(b, proposal.id, { reason: "r" })).toEqual({
      status: 404,
      body: { error: "No such Proposal" },
    });
    expect(await propose(b, finding.id, { decision: "mark_false_positive", reason: "r" })).toEqual({
      status: 404,
      body: { error: "No such Finding" },
    });
  });
});

describe("a Proposal its decision would refuse now", () => {
  it("answers 409 for an accept on a Fixed Finding, and stores nothing", async () => {
    const { team, finding } = await teamWithFinding();
    await findings.reconcile(scan(team, "scan-2", "2026-11-24T10:00:00Z", []));
    expect((await findings.list(team))[0]).toMatchObject({ status: "fixed" });
    const before = await stored(team);

    const answer = await propose(team, finding.id, {
      decision: "accept",
      reason: "r",
      until: nextWeek(),
    });

    expect(answer).toEqual({
      status: 409,
      body: { error: expect.any(String) },
    });
    expect(await stored(team)).toEqual(before);
  });

  it("answers 409 when the Finding changed after the Proposal was asked, and the Proposal stays pending", async () => {
    // A Member proposes a False positive; a Lead then accepts the Finding directly. Approving the old Proposal would
    // override that later decision.
    const { team, finding, proposal } = await pendingProposal();
    await post(`/api/findings/${finding.id}/accept`, {
      as: LEAD,
      team,
      body: { reason: "Fixed next sprint", until: nextWeek() },
    });
    const before = await stored(team);

    const answer = await approve(team, proposal.id);

    expect(answer).toEqual({ status: 409, body: { error: expect.any(String) } });
    expect(await stored(team)).toEqual(before);
    expect(before.proposals).toMatchObject([{ id: proposal.id, state: "pending" }]);
  });
});

/** GET /api/proposals as `as` in `team`; with `claims`, the token carries those instead of the Team's. */
async function listProposals(as: string, team: string, claims?: Record<string, unknown>) {
  const token = await sessionToken(key, as, 60, claims ?? activeOrganization(team));
  const res = await app.request("/api/proposals", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/proposals", () => {
  it.each([
    ["Member", MEMBER],
    ["Lead", LEAD],
    ["Admin", ADMIN],
  ])(
    "answers a %s the Team's id and its pending Proposals, each marked stale or not",
    async (_role, as) => {
      // Which Proposals are listed and in what order, and the stale rule itself, are Findings.pendingProposals'
      // (proposals.test.ts).
      const { team, finding } = await teamWithFinding();
      const first = Proposal.parse(
        (await propose(team, finding.id, { decision: "mark_false_positive", reason: "First" }))
          .body,
      );
      // A Lead's decision after the first was asked makes it stale.
      await post(`/api/findings/${finding.id}/accept`, {
        as: LEAD,
        team,
        body: { reason: "Fixed next sprint", until: nextWeek() },
      });

      const staleAnswer = await listProposals(as, team);
      expect(staleAnswer.status).toBe(200);
      expect(ProposalsBody.parse(staleAnswer.body)).toEqual({
        team,
        proposals: [{ ...first, stale: true }],
      });

      // Rejected, the Finding takes a new one, asked after the accept: not stale.
      expect((await reject(team, first.id, { reason: "Asked before the accept" })).status).toBe(
        200,
      );
      const second = Proposal.parse(
        (
          await propose(team, finding.id, {
            decision: "accept",
            reason: "Second",
            until: nextWeek(),
          })
        ).body,
      );

      const answer = await listProposals(as, team);

      expect(answer.status).toBe(200);
      expect(ProposalsBody.parse(answer.body)).toEqual({
        team,
        proposals: [{ ...second, stale: false }],
      });
    },
  );

  it("never answers another Team's Proposals", async () => {
    const a = await pendingProposal();
    const b = await pendingProposal();

    const answer = await listProposals(MEMBER, a.team);

    const parsed = ProposalsBody.parse(answer.body);
    expect(parsed.team).toBe(a.team);
    expect(parsed.proposals.map((p) => p.id)).toEqual([a.proposal.id]);
    expect(JSON.stringify(answer.body)).not.toContain(b.team);
    expect(JSON.stringify(answer.body)).not.toContain(b.proposal.id);
  });

  it("answers 401 with no session", async () => {
    const res = await app.request("/api/proposals");
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 401,
      body: { error: "Not signed in" },
    });
  });

  it("answers 403 with no active Team", async () => {
    const { team } = await teamWithFinding();
    expect(await listProposals(MEMBER, team, {})).toEqual({
      status: 403,
      body: { error: "Choose a Team first" },
    });
  });

  it("answers 409 for a Team not yet opened", async () => {
    expect(await listProposals("user_new", `org_${randomUUID()}`)).toEqual({
      status: 409,
      body: { error: "Your Team's Admin must open Warden first" },
    });
  });
});

// Each refused field is the contracts' (contracts/test/decisions.test.ts); one case proves the route answers 400.
describe("a Proposal's bad input", () => {
  it("answers 400 for an accept without until, and writes nothing", async () => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);

    const answer = await propose(team, finding.id, { decision: "accept", reason: "r" });

    expect(answer).toEqual({ status: 400, body: { error: expect.stringMatching(/until/) } });
    expect(await stored(team)).toEqual(before);
  });

  it("answers 400 for a blank reject reason, listing the field, and writes nothing", async () => {
    const { team, proposal } = await pendingProposal();
    const before = await stored(team);

    const answer = await reject(team, proposal.id, { reason: "  \n " });

    expect(answer).toEqual({ status: 400, body: { error: expect.stringMatching(/^reason: /) } });
    expect(await stored(team)).toEqual(before);
  });
});
