// A person's named decisions in the Findings module (ADR 0005): who may decide, which Status each call is allowed
// from, and that a refusal writes nothing. Run as warden_app on the suite's shared database, each test with Teams of
// its own, since history can't be deleted between tests. The stories themselves are proved at the API
// (decisions-api.test.ts).
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  type Actor,
  type Finding,
  type Observation,
  type Scan,
} from "@warden/contracts";
import type pg from "pg";
import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, FindingNotFound, NotALead, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { refusal, seedTeam } from "./helpers.ts";
import { poolAs } from "./databases.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({
    withTeam,
    moveRules: { guard: guardMoveRule, patch: patchMoveRule },
  });
});

afterAll(async () => {
  await pool.end();
});

const app = { kind: "repo", ref: "https://github.com/example/app" } as const;
const api = { kind: "repo", ref: "https://github.com/example/api" } as const;
const ENV = "guard/agent-can-read-env";
const MCP = "guard/mcp-server-unpinned";
const lead: Actor = { kind: "person", id: "user_lead" };
const member: Actor = { kind: "person", id: "user_member" };
const agent: Actor = { kind: "agent", id: "agent-1" };
const reason = "Decided in the weekly review";
const nextWeek = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

/** A new Team with a Lead (`lead`) and a Member (`member`). */
async function newTeam(): Promise<string> {
  const team = `org_decisions_${randomUUID()}`;
  await seedTeam(withTeam, team, [
    [lead.id, "lead"],
    [member.id, "member"],
  ]);
  return team;
}

let paths = 0;

/** A Finding stored straight into `findings`, each at a path of its own so none share a problem. */
async function given(team: string, overrides: Partial<Finding> = {}): Promise<Finding> {
  const location = { kind: "file", path: `config/${++paths}.json` } as const;
  const finding: Finding = {
    id: `f-${randomUUID()}`,
    team,
    asset: app,
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
  return finding;
}

/** Everything a Team has stored for its Findings: every row and every history row. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    findings: await tx.selectFrom("findings").selectAll().orderBy("id").execute(),
    history: await tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
  }));
}

/** Each named call, made with `actor` and the input it needs. */
const calls = {
  accept: (team: string, id: string, actor: Actor) =>
    findings.accept(team, id, { actor, reason, until: nextWeek() }),
  markFalsePositive: (team: string, id: string, actor: Actor) =>
    findings.markFalsePositive(team, id, { actor, reason }),
  confirmFix: (team: string, id: string, actor: Actor) =>
    findings.confirmFix(team, id, { actor, reason }),
  markMoved: (team: string, id: string, actor: Actor, candidate = "f-none") =>
    findings.markMoved(team, id, { actor, reason, candidate }),
  reopen: (team: string, id: string, actor: Actor) => findings.reopen(team, id, { actor, reason }),
};
type Call = keyof typeof calls;

/** A Fixed Finding with an Unconfirmed fix naming `candidate`, which is stored first. */
async function unconfirmedFix(team: string, candidate: Partial<Finding> = {}) {
  const moved = await given(team, { status: "open", ...candidate });
  const old = await given(team, { status: "fixed", unconfirmed_fix: { candidates: [moved.id] } });
  return { old, moved };
}

describe("a named decision by an agent", () => {
  it.each(Object.keys(calls) as Call[])("%s throws, and writes nothing", async (call) => {
    const team = await newTeam();
    const { old } = await unconfirmedFix(team);
    const open = await given(team);
    const before = await stored(team);

    await expect(calls[call](team, call === "reopen" ? open.id : old.id, agent)).rejects.toThrow(
      /agent only proposes/,
    );

    expect(await stored(team)).toEqual(before);
  });
});

describe("a named decision on a Status its call doesn't allow", () => {
  /**
   * Each case: the call, the Finding (plus a candidate for markMoved) it's made on, and the refusal's words exactly:
   * the API's 409 and the detail card show them, so they use the glossary's words, with no id and no call name.
   */
  const cases: [
    string,
    Call,
    (team: string) => Promise<{ id: string; candidate?: string }>,
    string,
  ][] = [
    [
      "accept on a Fixed Finding",
      "accept",
      (t) => given(t, { status: "fixed" }),
      "This Finding is now Fixed, so it can't be accepted.",
    ],
    [
      "accept on a False positive",
      "accept",
      (t) => given(t, { status: "false_positive" }),
      "This Finding is now a False positive, so it can't be accepted.",
    ],
    [
      "markFalsePositive on a Fixed Finding",
      "markFalsePositive",
      (t) => given(t, { status: "fixed" }),
      "This Finding is now Fixed, so it can't be marked a False positive.",
    ],
    [
      "markFalsePositive on a False positive",
      "markFalsePositive",
      (t) => given(t, { status: "false_positive" }),
      "This Finding is a False positive already.",
    ],
    [
      "confirmFix on an Open Finding",
      "confirmFix",
      (t) => given(t),
      "This Finding is now Open, so its fix can't be confirmed.",
    ],
    [
      "confirmFix on an Accepted Finding",
      "confirmFix",
      (t) => given(t, { status: "accepted", accepted_reason: reason, accepted_until: nextWeek() }),
      "This Finding is now Accepted, so its fix can't be confirmed.",
    ],
    [
      "confirmFix on a Fixed Finding with no Unconfirmed fix",
      "confirmFix",
      (t) => given(t, { status: "fixed" }),
      "This Finding has no Unconfirmed fix to confirm.",
    ],
    [
      "markMoved on a False positive",
      "markMoved",
      (t) => given(t, { status: "false_positive" }),
      "This Finding is now a False positive, so it can't be marked moved.",
    ],
    [
      "markMoved on a Fixed Finding with no Unconfirmed fix",
      "markMoved",
      (t) => given(t, { status: "fixed" }),
      "This Finding has no Unconfirmed fix to mark moved.",
    ],
    [
      "markMoved with a candidate it doesn't list",
      "markMoved",
      async (t) => {
        const { old } = await unconfirmedFix(t);
        const other = await given(t);
        return { id: old.id, candidate: other.id };
      },
      "The chosen Finding isn't one of this Unconfirmed fix's candidates.",
    ],
    [
      "markMoved with a candidate that isn't Open",
      "markMoved",
      async (t) => {
        const { old, moved } = await unconfirmedFix(t, { status: "false_positive" });
        return { id: old.id, candidate: moved.id };
      },
      "The chosen Finding is a False positive, not Open, so it can't be merged into this one.",
    ],
    [
      "markMoved with a candidate merged into another",
      "markMoved",
      async (t) => {
        const into = await given(t);
        const { old, moved } = await unconfirmedFix(t, { status: "fixed", moved_to: into.id });
        return { id: old.id, candidate: moved.id };
      },
      "The chosen Finding was merged into another Finding, so it can't be merged into this one.",
    ],
    [
      "markMoved with a candidate the Team no longer has",
      "markMoved",
      async (t) => {
        const old = await given(t, {
          status: "fixed",
          unconfirmed_fix: { candidates: ["f-gone"] },
        });
        return { id: old.id, candidate: "f-gone" };
      },
      "The chosen Finding no longer exists, so it can't be merged into this one.",
    ],
    [
      "markMoved with a candidate under another Rule",
      "markMoved",
      async (t) => {
        const location = { kind: "file", path: "other-rule.json" } as const;
        const { old, moved } = await unconfirmedFix(t, {
          rule_id: MCP,
          location,
          fingerprint: fingerprint(MCP, location),
        });
        return { id: old.id, candidate: moved.id };
      },
      "The chosen Finding has another Rule, so it can't be merged into this one.",
    ],
    [
      "markMoved with a candidate from another module",
      "markMoved",
      async (t) => {
        const rule = "patch/known-vulnerability";
        const location = { kind: "file", path: "package.json" } as const;
        const { old, moved } = await unconfirmedFix(t, {
          module: "patch",
          rule_id: rule,
          location,
          fingerprint: fingerprint(rule, location),
        });
        return { id: old.id, candidate: moved.id };
      },
      "The chosen Finding has another module and Rule, so it can't be merged into this one.",
    ],
    [
      "markMoved with a candidate on another Asset",
      "markMoved",
      async (t) => {
        const { old, moved } = await unconfirmedFix(t, { asset: api });
        return { id: old.id, candidate: moved.id };
      },
      "The chosen Finding has another Asset, so it can't be merged into this one.",
    ],
    ["reopen on an Open Finding", "reopen", (t) => given(t), "This Finding is Open already."],
    [
      "reopen on a Fixed Finding",
      "reopen",
      (t) => given(t, { status: "fixed" }),
      "This Finding is now Fixed, so it can't be reopened.",
    ],
  ];

  it.each(cases)(
    "%s throws DecisionRefused in plain words, and writes nothing",
    async (_name, call, make, words) => {
      const team = await newTeam();
      const { id, candidate } = await make(team);
      const before = await stored(team);

      expect(await refusal(calls[call](team, id, lead, candidate))).toEqual({
        name: "DecisionRefused",
        message: words,
      });
      expect(await stored(team)).toEqual(before);
    },
  );

  it.each<[Call, string]>([
    ["accept", "This Finding was merged into another Finding, so it can't be accepted."],
    [
      "markFalsePositive",
      "This Finding was merged into another Finding, so it can't be marked a False positive.",
    ],
    ["confirmFix", "This Finding was merged into another Finding, so its fix can't be confirmed."],
    ["markMoved", "This Finding was merged into another Finding, so it can't be marked moved."],
    ["reopen", "This Finding was merged into another Finding, so it can't be reopened."],
  ])("%s refuses a Finding merged into another, in plain words", async (call, words) => {
    const team = await newTeam();
    const into = await given(team);
    // A merged Finding is refused before its Status is looked at.
    const merged = await given(team, { status: "fixed", moved_to: into.id });
    const before = await stored(team);

    expect(await refusal(calls[call](team, merged.id, lead, into.id))).toEqual({
      name: "DecisionRefused",
      message: words,
    });
    expect(await stored(team)).toEqual(before);
  });
});

describe("a named decision on a Finding the Team doesn't have", () => {
  it("throws FindingNotFound for another Team's id, and writes nothing in either Team", async () => {
    const [a, b] = [await newTeam(), await newTeam()];
    const theirs = await given(a);
    const before = [await stored(a), await stored(b)];

    await expect(calls.accept(b, theirs.id, lead)).rejects.toBeInstanceOf(FindingNotFound);

    expect([await stored(a), await stored(b)]).toEqual(before);
  });
});

describe("a named decision with bad input", () => {
  // The rules themselves are the contracts' (contracts/test/decisions.test.ts); this shows the module applies them.
  it("throws a zod error, and writes nothing", async () => {
    const team = await newTeam();
    const finding = await given(team);
    const before = await stored(team);

    await expect(
      findings.accept(team, finding.id, { actor: lead, reason: "   ", until: nextWeek() }),
    ).rejects.toThrow(ZodError);

    expect(await stored(team)).toEqual(before);
  });
});

describe("a named decision by a person who isn't a Lead under the lock", () => {
  it.each([
    ["a Member", member],
    ["someone not in the Team", { kind: "person", id: "user_stranger" } as Actor],
  ])("by %s throws NotALead, and writes nothing", async (_name, actor) => {
    const team = await newTeam();
    const finding = await given(team);
    const before = await stored(team);

    await expect(
      findings.markFalsePositive(team, finding.id, { actor, reason }),
    ).rejects.toBeInstanceOf(NotALead);

    expect(await stored(team)).toEqual(before);
  });
});

describe("markMoved and the other Unconfirmed fixes naming its candidate", () => {
  it("takes the merged candidate off every other Finding's candidates, and clears a list left empty", async () => {
    const team = await newTeam();
    const candidate = await given(team);
    const other = await given(team);
    const old = await given(team, {
      status: "fixed",
      unconfirmed_fix: { candidates: [candidate.id] },
    });
    const sharing = await given(team, {
      status: "fixed",
      unconfirmed_fix: { candidates: [candidate.id, other.id] },
    });
    const only = await given(team, {
      status: "fixed",
      unconfirmed_fix: { candidates: [candidate.id] },
    });

    await findings.markMoved(team, old.id, { actor: lead, reason, candidate: candidate.id });

    const after = new Map((await findings.list(team)).map((f) => [f.id, f]));
    expect(after.get(sharing.id)).toMatchObject({
      status: "fixed",
      unconfirmed_fix: { candidates: [other.id] },
    });
    expect(after.get(only.id)).toMatchObject({ status: "fixed", unconfirmed_fix: null });
    expect(after.get(candidate.id)).toMatchObject({ status: "fixed", moved_to: old.id });
  });
});

describe("the allowed decisions", () => {
  it("accept renews an Accepted Finding, with the new reason and until", async () => {
    const team = await newTeam();
    const finding = await given(team, {
      status: "accepted",
      accepted_reason: "First time",
      accepted_until: "2030-01-01T00:00:00Z",
    });
    const until = nextWeek();

    const renewed = await findings.accept(team, finding.id, { actor: lead, reason, until });

    expect(renewed).toMatchObject({
      status: "accepted",
      accepted_reason: reason,
      accepted_until: until.replace(/\.000Z$/, "Z"),
    });
  });

  it("markFalsePositive takes an Accepted Finding, and clears what accepting set", async () => {
    const team = await newTeam();
    const finding = await given(team, {
      status: "accepted",
      accepted_reason: "First time",
      accepted_until: "2030-01-01T00:00:00Z",
    });

    expect(await calls.markFalsePositive(team, finding.id, lead)).toMatchObject({
      status: "false_positive",
      accepted_reason: null,
      accepted_until: null,
    });
    expect(await findings.history(team, finding.id)).toEqual([
      expect.objectContaining({
        status_before: "accepted",
        status_after: "false_positive",
        cause: { kind: "person", id: lead.id },
        reason,
      }),
    ]);
  });
});

describe("a decision and a Scan for one Team at the same time", () => {
  /** A Scan that sees the Finding again, with a new Severity and title. */
  const scanSeeing = (team: string, finding: Finding): Scan => {
    const observation: Observation = {
      asset: finding.asset,
      rule_id: finding.rule_id,
      location: finding.location,
      severity: "critical",
      title: "The agent can read every .env file",
      evidence: finding.evidence,
    };
    return {
      id: `scan-${randomUUID()}`,
      team,
      module: "guard",
      started_at: new Date().toISOString(),
      assets: [app],
      rules: [ENV],
      observations: [observation],
    };
  };

  /** What should match whatever the order: the Finding's Status, Severity and title, and each change's cause. */
  const shape = async (team: string, id: string) => {
    const [finding] = await findings.list(team);
    return {
      finding: {
        status: finding!.status,
        severity: finding!.severity,
        title: finding!.title,
        accepted_reason: finding!.accepted_reason,
      },
      causes: (await findings.history(team, id))
        .map((entry) => `${entry.cause.kind}: ${entry.status_before} to ${entry.status_after}`)
        .sort(),
    };
  };

  it("leave what the same two leave one after the other", async () => {
    const sequential = [];
    for (const decisionFirst of [true, false]) {
      const team = await newTeam();
      const finding = await given(team);
      const accept = () => calls.accept(team, finding.id, lead);
      const scan = () => findings.reconcile(scanSeeing(team, finding));
      if (decisionFirst) {
        await accept();
        await scan();
      } else {
        await scan();
        await accept();
      }
      sequential.push(await shape(team, finding.id));
    }

    for (let run = 0; run < 5; run++) {
      const team = await newTeam();
      const finding = await given(team);
      await Promise.all([
        calls.accept(team, finding.id, lead),
        findings.reconcile(scanSeeing(team, finding)),
      ]);
      expect(sequential).toContainEqual(await shape(team, finding.id));
    }
  });
});
