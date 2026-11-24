// Proposals in the Findings module (ADR 0005, ADR 0008): an agent or a person proposes, a Lead approves or rejects,
// and the Proposal keeps who asked and who decided. Run as warden_app on the suite's shared database, each test with
// a Team of its own. Story 4's Proposal part is proved at the API (proposals-api.test.ts).
import { randomUUID } from "node:crypto";
import { fingerprint, HistoryEntryBody, type Actor, type Finding } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ZodError } from "zod";
import {
  createFindings,
  DecisionRefused,
  FindingNotFound,
  ProposalDecided,
  ProposalNotFound,
  type Findings,
} from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { seedTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
});

afterAll(async () => {
  await pool.end();
});

const ENV = "guard/agent-can-read-env";
const lead: Actor = { kind: "person", id: "user_lead" };
const member: Actor = { kind: "person", id: "user_member" };
const agent: Actor = { kind: "agent", id: "guard-bot" };
const nextWeek = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

/** A new Team with a Lead and a Member, and one Open Finding. */
async function teamWithFinding(overrides: Partial<Finding> = {}) {
  const team = `org_proposals_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [lead.id, "lead"],
    [member.id, "member"],
  ]);
  const location = { kind: "file", path: ".claude/settings.json" } as const;
  const finding: Finding = {
    id: `f-${randomUUID()}`,
    team,
    asset: { kind: "repo", ref: "https://github.com/example/app" },
    module: "guard",
    rule_id: ENV,
    fingerprint: fingerprint(ENV, location),
    location,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...overrides,
  };
  await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(finding)).execute());
  return { team, finding };
}

/** Everything the Team has stored for its Findings and Proposals. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    findings: await tx.selectFrom("findings").selectAll().orderBy("id").execute(),
    history: await tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
    proposals: await tx.selectFrom("proposals").selectAll().orderBy("id").execute(),
  }));
}

describe("an agent's Proposal, approved by a person", () => {
  it("keeps both: the agent as who asked, the person as who decided and as the history row's actor", async () => {
    const { team, finding } = await teamWithFinding();

    const proposed = await findings.propose(team, finding.id, {
      requester: agent,
      decision: "mark_false_positive",
      reason: "The file is a test fixture",
    });
    const approved = await findings.approveProposal(team, proposed.id, { actor: lead });

    expect(proposed).toMatchObject({
      finding_id: finding.id,
      state: "pending",
      requested_by: agent,
      until: null,
      decided_by: null,
    });
    expect(approved).toMatchObject({
      id: proposed.id,
      state: "approved",
      requested_by: agent,
      decided_by: lead.id,
      decided_reason: null,
    });
    expect(approved.decided_at).not.toBeNull();
    const change = (await findings.history(team, finding.id)).at(-1);
    expect(HistoryEntryBody.parse(change)).toMatchObject({
      status_before: "open",
      status_after: "false_positive",
      cause: { kind: "person", id: lead.id },
      reason: "The file is a test fixture",
      proposal: { id: proposed.id, requested_by: agent },
    });
    expect((await findings.list(team))[0]).toMatchObject({ status: "false_positive" });
  });
});

describe("approving or rejecting as an agent", () => {
  it.each(["approveProposal", "rejectProposal"] as const)(
    "%s throws before anything is read, and the Proposal stays pending",
    async (call) => {
      const { team, finding } = await teamWithFinding();
      const proposed = await findings.propose(team, finding.id, {
        requester: member,
        decision: "mark_false_positive",
        reason: "r",
      });
      const before = await stored(team);
      const reached: string[] = [];
      const watched = createFindings({
        withTeam: (t, work) => {
          reached.push(t);
          return withTeam(t, work);
        },
        moveRules: {},
      });

      await expect(
        call === "approveProposal"
          ? watched.approveProposal(team, proposed.id, { actor: agent })
          : watched.rejectProposal(team, proposed.id, { actor: agent, reason: "r" }),
      ).rejects.toThrow(/agent only proposes/);

      expect(reached).toEqual([]);
      expect(await stored(team)).toEqual(before);
    },
  );
});

describe("approving a Proposal the decision would now refuse", () => {
  it("an accept whose until has passed throws DecisionRefused, and the Proposal stays pending", async () => {
    const { team, finding } = await teamWithFinding();
    // Stored past `propose`, which refuses an until that isn't later than now.
    await withTeam(team, (tx) =>
      tx
        .insertInto("proposals")
        .values({
          team_id: team,
          id: "p-stale",
          finding_id: finding.id,
          decision: "accept",
          reason: "Next sprint",
          accepted_until: "2020-01-01T00:00:00Z",
          requested_by_kind: "person",
          requested_by_id: member.id,
        })
        .execute(),
    );
    const before = await stored(team);

    await expect(findings.approveProposal(team, "p-stale", { actor: lead })).rejects.toThrow(
      DecisionRefused,
    );

    expect(await stored(team)).toEqual(before);
  });

  it("an accept whose Finding a Lead has since marked a False positive throws DecisionRefused", async () => {
    const { team, finding } = await teamWithFinding();
    const proposed = await findings.propose(team, finding.id, {
      requester: member,
      decision: "accept",
      reason: "Next sprint",
      until: nextWeek(),
    });
    await findings.markFalsePositive(team, finding.id, { actor: lead, reason: "A fixture" });
    const before = await stored(team);

    await expect(findings.approveProposal(team, proposed.id, { actor: lead })).rejects.toThrow(
      DecisionRefused,
    );

    expect(await stored(team)).toEqual(before);
    expect(before.proposals).toMatchObject([{ id: proposed.id, state: "pending" }]);
  });
});

/**
 * Findings whose transaction begins, then waits for `release` before its work: one that began first and writes later,
 * as a transaction waiting on the Team's lock does. `begun` resolves once its transaction has begun in Postgres.
 */
function heldFindings() {
  let begin!: () => void;
  let release!: () => void;
  const begun = new Promise<void>((resolve) => (begin = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const held: WithTeam = (team, work) =>
    withTeam(team, async (tx) => {
      begin();
      await released;
      return work(tx);
    });
  return { findings: createFindings({ withTeam: held, moveRules: {} }), begun, release };
}

describe("approving, when a transaction began before the other but wrote after it", () => {
  it("refuses a Proposal asked while a Lead's decision waited to write, and the Proposal stays pending", async () => {
    const { team, finding } = await teamWithFinding();
    const held = heldFindings();
    const accepting = held.findings.accept(team, finding.id, {
      actor: lead,
      reason: "Next sprint",
      until: nextWeek(),
    });
    await held.begun;
    const proposed = await findings.propose(team, finding.id, {
      requester: member,
      decision: "mark_false_positive",
      reason: "The file is a test fixture",
    });
    held.release();
    await accepting;
    const before = await stored(team);

    await expect(findings.approveProposal(team, proposed.id, { actor: lead })).rejects.toThrow(
      /changed since the Proposal was asked/,
    );

    expect(await stored(team)).toEqual(before);
    expect(before.findings).toMatchObject([{ status: "accepted" }]);
    expect(before.proposals).toMatchObject([{ id: proposed.id, state: "pending" }]);
  });

  it("approves a Proposal whose transaction began before a Lead's decision but wrote after it", async () => {
    const { team, finding } = await teamWithFinding();
    const held = heldFindings();
    const proposing = held.findings.propose(team, finding.id, {
      requester: member,
      decision: "mark_false_positive",
      reason: "The file is a test fixture",
    });
    await held.begun;
    await findings.accept(team, finding.id, {
      actor: lead,
      reason: "Next sprint",
      until: nextWeek(),
    });
    held.release();
    const proposed = await proposing;

    await expect(
      findings.approveProposal(team, proposed.id, { actor: lead }),
    ).resolves.toMatchObject({ state: "approved" });

    expect((await findings.list(team))[0]).toMatchObject({ status: "false_positive" });
  });
});

describe("proposing", () => {
  it("an accept stores its until, changes no Finding, and writes no history", async () => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);
    const until = nextWeek();

    const proposed = await findings.propose(team, finding.id, {
      requester: member,
      decision: "accept",
      reason: "Next sprint",
      until,
    });

    expect(Date.parse(proposed.until!)).toBe(Date.parse(until));
    const after = await stored(team);
    expect(after.findings).toEqual(before.findings);
    expect(after.history).toEqual(before.history);
    expect(after.proposals).toHaveLength(1);
  });

  // Each refused field is the contracts' (contracts/test/decisions.test.ts); one case proves propose checks them.
  it("throws a zod error for an until in the past, and stores nothing", async () => {
    const { team, finding } = await teamWithFinding();
    const before = await stored(team);

    await expect(
      findings.propose(team, finding.id, {
        requester: member,
        decision: "accept",
        reason: "r",
        until: "2020-01-01T00:00:00Z",
      }),
    ).rejects.toThrow(ZodError);

    expect(await stored(team)).toEqual(before);
  });

  it("throws DecisionRefused for a Finding merged into another, and stores nothing", async () => {
    const { team, finding } = await teamWithFinding();
    const location = { kind: "file", path: "moved.json" } as const;
    const merged: Finding = {
      ...finding,
      id: `f-${randomUUID()}`,
      location,
      fingerprint: fingerprint(ENV, location),
      status: "fixed",
      moved_to: finding.id,
    };
    await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(merged)).execute());
    const before = await stored(team);

    await expect(
      findings.propose(team, merged.id, {
        requester: agent,
        decision: "mark_false_positive",
        reason: "r",
      }),
    ).rejects.toThrow(/it is merged into/);

    expect(await stored(team)).toEqual(before);
  });

  it("throws FindingNotFound for another Team's Finding, and stores nothing in either Team", async () => {
    const a = await teamWithFinding();
    const b = await teamWithFinding();
    const [beforeA, beforeB] = [await stored(a.team), await stored(b.team)];

    await expect(
      findings.propose(b.team, a.finding.id, {
        requester: agent,
        decision: "mark_false_positive",
        reason: "r",
      }),
    ).rejects.toThrow(FindingNotFound);

    expect(await stored(a.team)).toEqual(beforeA);
    expect(await stored(b.team)).toEqual(beforeB);
  });
});

describe("a Proposal no longer pending, or not the Team's", () => {
  it("throws ProposalDecided naming its state, for approve and reject alike", async () => {
    const { team, finding } = await teamWithFinding();
    const proposed = await findings.propose(team, finding.id, {
      requester: member,
      decision: "mark_false_positive",
      reason: "r",
    });
    await findings.rejectProposal(team, proposed.id, { actor: lead, reason: "Fix it now" });
    const before = await stored(team);

    await expect(findings.approveProposal(team, proposed.id, { actor: lead })).rejects.toThrow(
      new ProposalDecided(proposed.id, "rejected"),
    );
    await expect(
      findings.rejectProposal(team, proposed.id, { actor: lead, reason: "Again" }),
    ).rejects.toThrow(ProposalDecided);

    expect(await stored(team)).toEqual(before);
  });

  it("throws ProposalNotFound for another Team's Proposal id", async () => {
    const a = await teamWithFinding();
    const b = await teamWithFinding();
    const proposed = await findings.propose(a.team, a.finding.id, {
      requester: member,
      decision: "mark_false_positive",
      reason: "r",
    });

    await expect(findings.approveProposal(b.team, proposed.id, { actor: lead })).rejects.toThrow(
      ProposalNotFound,
    );
    expect((await stored(a.team)).proposals).toMatchObject([{ state: "pending" }]);
  });
});

describe("the Team's pending Proposals", () => {
  it("lists only pending ones, oldest first, each with the Proposal's fields", async () => {
    const { team, finding } = await teamWithFinding();
    const ask = (reason: string) =>
      findings.propose(team, finding.id, {
        requester: member,
        decision: "mark_false_positive",
        reason,
      });
    const first = await ask("first");
    const rejected = await ask("rejected");
    const third = await ask("third");
    await findings.rejectProposal(team, rejected.id, { actor: lead, reason: "No" });

    expect(await findings.pendingProposals(team)).toEqual([
      { ...first, stale: false },
      { ...third, stale: false },
    ]);
  });

  it("marks one stale when its Finding changed after it was asked, the same as approving it refuses", async () => {
    const { team, finding } = await teamWithFinding();
    const old = await findings.propose(team, finding.id, {
      requester: member,
      decision: "mark_false_positive",
      reason: "Asked before the accept",
    });
    await findings.accept(team, finding.id, { actor: lead, reason: "Later", until: nextWeek() });
    const fresh = await findings.propose(team, finding.id, {
      requester: agent,
      decision: "mark_false_positive",
      reason: "Asked after the accept",
    });

    expect(
      (await findings.pendingProposals(team)).map((p) => [p.reason, p.stale] as const),
    ).toEqual([
      ["Asked before the accept", true],
      ["Asked after the accept", false],
    ]);
    await expect(findings.approveProposal(team, old.id, { actor: lead })).rejects.toThrow(
      /changed since the Proposal was asked/,
    );
    await expect(findings.approveProposal(team, fresh.id, { actor: lead })).resolves.toMatchObject({
      state: "approved",
    });
  });
});
