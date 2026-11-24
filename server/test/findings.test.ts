// Stories 6, 7 (the Scan half) and 8: a module reports what it saw through one call, the Findings module alone decides
// Status, and history keeps every change. Run as warden_app on the suite's shared database, each test with Teams of
// its own, since history can't be deleted between tests.
import { randomUUID } from "node:crypto";
import { fingerprint, Finding, type Observation, type Scan, type SpotRun } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { closedPort } from "./ports.ts";

const pools: pg.Pool[] = [];
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  const pool = poolAs("warden_app", inject("testDatabase"));
  pools.push(pool);
  withTeam = createWithTeam(pool);
  findings = createFindings({
    withTeam,
    moveRules: { guard: guardMoveRule, patch: patchMoveRule },
  });
});

afterAll(async () => {
  for (const pool of pools) await pool.end();
});

const app = { kind: "repo", ref: "https://github.com/example/app" } as const;
const api = { kind: "repo", ref: "https://github.com/example/api" } as const;
const ENV = "guard/agent-can-read-env";
const MCP = "guard/mcp-server-unpinned";

/** A new Team with its `teams` row. */
async function newTeam(): Promise<string> {
  const team = `org_findings_${randomUUID()}`;
  await withTeam(team, (tx) => tx.insertInto("teams").values({ id: team }).execute());
  return team;
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    asset: app,
    rule_id: ENV,
    location: { kind: "file", path: ".claude/settings.json", line: 3 },
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    ...overrides,
  };
}

function scanOf(team: string, overrides: Partial<Scan> = {}): Scan {
  return {
    id: `scan-${randomUUID()}`,
    team,
    module: "guard",
    started_at: "2026-11-24T09:00:00Z",
    assets: [app],
    rules: [ENV],
    observations: [observation()],
    ...overrides,
  };
}

function spotRunOf(team: string, overrides: Partial<SpotRun> = {}): SpotRun {
  return {
    id: `spot-${randomUUID()}`,
    team,
    module: "guard",
    started_at: "2026-11-24T09:00:00Z",
    observations: [observation()],
    ...overrides,
  };
}

/** Everything a Team has stored: its Findings, every history row, and the Scans it reconciled. */
function stored(team: string) {
  return withTeam(team, async (tx) => ({
    findings: await tx.selectFrom("findings").selectAll().orderBy("id").execute(),
    history: await tx.selectFrom("finding_history").selectAll().orderBy("id").execute(),
    scans: await tx.selectFrom("scans").selectAll().orderBy("id").execute(),
    coverage: await tx.selectFrom("scan_coverage").selectAll().execute(),
  }));
}

describe("findings.scan: the call a module writes", () => {
  it("opens a Finding that reads back as a Finding, with its Fingerprint and Status open", async () => {
    const team = await newTeam();

    const outcome = await findings.scan(
      { team, module: "guard", assets: [app], rules: [ENV] },
      async (scan) => {
        scan.saw(observation());
      },
    );

    const [finding, ...rest] = await findings.list(team);
    expect(rest).toEqual([]);
    expect(Finding.safeParse(finding).success).toBe(true);
    expect(Object.isFrozen(finding)).toBe(true);
    expect(finding).toMatchObject({
      team,
      asset: app,
      module: "guard",
      rule_id: ENV,
      fingerprint: fingerprint(ENV, observation().location),
      status: "open",
      first_seen_scan: finding!.last_seen_scan,
    });
    expect(outcome).toEqual({
      opened: [{ id: finding!.id, observation: 0 }],
      seen: [],
      fixed: [],
      reopened: [],
      alreadyApplied: false,
    });
  });

  it("throws at once on an Asset or a Rule the Scan doesn't cover", async () => {
    const team = await newTeam();
    const thrown: unknown[] = [];

    await findings.scan({ team, module: "guard", assets: [app], rules: [ENV] }, async (scan) => {
      for (const outside of [observation({ asset: api }), observation({ rule_id: MCP })]) {
        try {
          scan.saw(outside);
        } catch (error) {
          thrown.push(error);
        }
      }
    });

    expect(thrown.map(String)).toEqual([
      expect.stringMatching(/Asset .*api.* isn't one this Scan covers/),
      expect.stringMatching(/Rule guard\/mcp-server-unpinned isn't one this Scan covers/),
    ]);
    expect(await findings.list(team)).toEqual([]);
  });

  it.each([
    ["status", { status: "open" }],
    ["fingerprint", { fingerprint: "guard/agent-can-read-env|file:.env" }],
  ])("refuses an Observation carrying a %s", async (key, extra) => {
    const team = await newTeam();

    await expect(
      findings.scan({ team, module: "guard", assets: [app], rules: [ENV] }, async (scan) => {
        scan.saw({ ...observation(), ...extra } as Observation);
      }),
    ).rejects.toThrow(new RegExp(key));
    expect(await stored(team)).toMatchObject({ findings: [], history: [], scans: [] });
  });

  it("throws on a second Observation of the same Asset and Fingerprint, and writes nothing", async () => {
    const team = await newTeam();
    let second: unknown;

    await expect(
      findings.scan({ team, module: "guard", assets: [app], rules: [ENV] }, async (scan) => {
        scan.saw(observation());
        try {
          scan.saw(
            observation({ location: { kind: "file", path: ".claude/settings.json", line: 9 } }),
          );
        } catch (error) {
          second = error;
          throw error;
        }
      }),
    ).rejects.toBe(second);
    expect(String(second)).toMatch(/same problem/);
    expect(await stored(team)).toMatchObject({ findings: [], history: [], scans: [] });
  });

  it("rejects with the callback's own error after a saw, leaving Findings, history and Scans unchanged", async () => {
    const team = await newTeam();
    await findings.reconcile(scanOf(team));
    const before = await stored(team);
    const listBefore = await findings.list(team);
    const historyBefore = await findings.history(team, listBefore[0]!.id);
    const boom = new Error("the scanner crashed");

    await expect(
      findings.scan(
        { team, module: "guard", assets: [app, api], rules: [ENV, MCP] },
        async (scan) => {
          scan.saw(observation({ asset: api }));
          throw boom;
        },
      ),
    ).rejects.toBe(boom);

    expect(await stored(team)).toEqual(before);
    expect(await findings.list(team)).toEqual(listBefore);
    expect(await findings.history(team, listBefore[0]!.id)).toEqual(historyBefore);
  });
});

describe("what reconcile and report refuse, writing nothing", () => {
  it("refuses a Scan that covers an Agent session", async () => {
    const team = await newTeam();
    const session = { kind: "agent_session", ref: "session-7f3a" } as const;

    await expect(
      findings.reconcile(scanOf(team, { assets: [app, session], observations: [] })),
    ).rejects.toThrow(/Agent session is never rescanned/);
    expect(await stored(team)).toMatchObject({ findings: [], scans: [], coverage: [] });
  });

  it("refuses a Scan with an Observation outside what it covered", async () => {
    const team = await newTeam();

    await expect(
      findings.reconcile(scanOf(team, { observations: [observation({ asset: api })] })),
    ).rejects.toThrow(/Asset is one the Scan covered/);
    expect(await stored(team)).toMatchObject({ findings: [], scans: [], coverage: [] });
  });

  it("refuses a Scan or Spot run for a Team with no teams row, by the foreign key", async () => {
    const team = `org_nobody_${randomUUID()}`;

    await expect(findings.reconcile(scanOf(team))).rejects.toMatchObject({ code: "23503" });
    await expect(findings.report(spotRunOf(team))).rejects.toMatchObject({ code: "23503" });
    expect(await stored(team)).toMatchObject({ findings: [], history: [], scans: [] });
  });

  it("refuses two Observations of one problem in a Scan or a Spot run", async () => {
    const team = await newTeam();
    const twice = [observation(), observation({ severity: "low" })];

    await expect(findings.reconcile(scanOf(team, { observations: twice }))).rejects.toThrow(
      /same problem/,
    );
    await expect(findings.report(spotRunOf(team, { observations: twice }))).rejects.toThrow(
      /same problem/,
    );
    expect(await stored(team)).toMatchObject({ findings: [], scans: [] });
  });

  it("rejects with the driver's error when the database can't be reached", async () => {
    const unreachable = createPool(
      createLogger(() => {}),
      { host: "127.0.0.1", port: await closedPort(), max: 1 },
    );
    pools.push(unreachable);
    const offline = createFindings({ withTeam: createWithTeam(unreachable), moveRules: {} });

    await expect(offline.reconcile(scanOf("org_offline"))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});

describe("report: a Spot run", () => {
  it("never marks a Finding Fixed, even an Open one on an Asset it reports on without seeing it", async () => {
    const team = await newTeam();
    await findings.reconcile(scanOf(team));
    const [open] = await findings.list(team);

    const outcome = await findings.report(
      spotRunOf(team, {
        observations: [
          observation({ rule_id: MCP, location: { kind: "file", path: ".mcp.json", line: 5 } }),
        ],
      }),
    );

    expect(outcome.fixed).toEqual([]);
    const after = await findings.list(team);
    expect(after.find((f) => f.id === open!.id)?.status).toBe("open");
    expect(after.map((f) => f.status)).toEqual(["open", "open"]);
  });

  it("changes nothing when retried", async () => {
    const team = await newTeam();
    const run = spotRunOf(team);
    await findings.report(run);
    const before = await stored(team);

    const outcome = await findings.report(run);

    expect(outcome).toEqual({
      opened: [],
      seen: [],
      fixed: [],
      reopened: [],
      alreadyApplied: true,
    });
    expect(await stored(team)).toEqual(before);
  });
});

describe("history", () => {
  it("keeps a Severity change with the Severity before and after", async () => {
    const team = await newTeam();
    await findings.reconcile(scanOf(team, { started_at: "2026-11-24T09:00:00Z" }));
    const second = scanOf(team, {
      started_at: "2026-11-24T10:00:00Z",
      observations: [observation({ severity: "critical" })],
    });

    await findings.reconcile(second);

    const [finding] = await findings.list(team);
    expect(finding!.severity).toBe("critical");
    const rows = await findings.history(team, finding!.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status_before: "open",
      status_after: "open",
      severity_before: "high",
      severity_after: "critical",
      actor: { kind: "scan", id: second.id },
      reason: expect.stringContaining(second.id),
    });
  });

  it("keeps opened, fixed and reopened in order, each naming its Scan and a reason", async () => {
    const team = await newTeam();
    const opens = scanOf(team, { started_at: "2026-11-24T09:00:00Z" });
    const fixes = scanOf(team, { started_at: "2026-11-24T10:00:00Z", observations: [] });
    const reopens = scanOf(team, { started_at: "2026-11-24T11:00:00Z" });

    for (const scan of [opens, fixes, reopens]) await findings.reconcile(scan);

    const [finding] = await findings.list(team);
    const rows = await findings.history(team, finding!.id);
    expect(
      rows.map(({ status_before, status_after, actor }) => [status_before, status_after, actor.id]),
    ).toEqual([
      [null, "open", opens.id],
      ["open", "fixed", fixes.id],
      ["fixed", "open", reopens.id],
    ]);
    for (const [i, scan] of [opens, fixes, reopens].entries()) {
      expect(rows[i]!.reason).toContain(scan.id);
      expect(rows[i]!.actor.kind).toBe("scan");
      expect(Number.isNaN(Date.parse(rows[i]!.at))).toBe(false);
    }
    expect(rows[1]!.reason).toMatch(/not seen/);
  });

  it("writes nothing for a Finding seen again unchanged", async () => {
    const team = await newTeam();
    await findings.reconcile(scanOf(team, { started_at: "2026-11-24T09:00:00Z" }));
    await findings.reconcile(scanOf(team, { started_at: "2026-11-24T10:00:00Z" }));

    const [finding] = await findings.list(team);
    expect(await findings.history(team, finding!.id)).toHaveLength(1);
  });
});

describe("Unconfirmed fix", () => {
  it("never flags one for a Vouch Scan, which has no move rule", async () => {
    const team = await newTeam();
    const product = { kind: "product", ref: "shop" } as const;
    const rule = "vouch/control-evidence-missing";
    const vouch = (id: string, started_at: string, path: string) =>
      scanOf(team, {
        id,
        module: "vouch",
        started_at,
        assets: [product],
        rules: [rule],
        observations: [
          observation({ asset: product, rule_id: rule, location: { kind: "file", path } }),
        ],
      });

    await findings.reconcile(vouch("vouch-1", "2026-11-24T09:00:00Z", "docs/policy.md"));
    const outcome = await findings.reconcile(
      vouch("vouch-2", "2026-11-24T10:00:00Z", "docs/policy-v2.md"),
    );

    expect(outcome.fixed).toHaveLength(1);
    expect(outcome.opened).toHaveLength(1);
    const fixed = (await findings.list(team)).find((f) => f.status === "fixed");
    expect(fixed?.unconfirmed_fix).toBeNull();
  });
});

describe("two Scans for one Team at the same time", () => {
  /** Two Scans whose order matters: the earlier-started sees a problem the later one doesn't. */
  const pair = (team: string) => {
    const first = scanOf(team, {
      id: "scan-first",
      started_at: "2026-11-24T09:00:00Z",
      assets: [app, api],
      rules: [ENV, MCP],
      observations: [
        observation(),
        observation({ asset: api }),
        observation({ rule_id: MCP, location: { kind: "file", path: ".mcp.json" } }),
      ],
    });
    const second = scanOf(team, {
      id: "scan-second",
      started_at: "2026-11-24T10:00:00Z",
      assets: [app],
      rules: [ENV],
      observations: [
        observation({ location: { kind: "file", path: ".claude/settings.local.json" } }),
      ],
    });
    return [first, second] as const;
  };

  /** What should match whatever the order: each Finding's Asset, Fingerprint, Status and last Scan. */
  const shape = async (team: string) =>
    (await findings.list(team))
      .map((f) => ({
        asset: f.asset,
        fingerprint: f.fingerprint,
        status: f.status,
        last_seen_scan: f.last_seen_scan,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  it("leave the same Findings as the same two one after the other", async () => {
    const inOrder = await newTeam();
    for (const scan of pair(inOrder)) await findings.reconcile(scan);
    const reversed = await newTeam();
    for (const scan of [...pair(reversed)].reverse()) await findings.reconcile(scan);
    const sequential = [await shape(inOrder), await shape(reversed)];

    for (let run = 0; run < 5; run++) {
      const together = await newTeam();
      await Promise.all(pair(together).map((scan) => findings.reconcile(scan)));
      expect(sequential).toContainEqual(await shape(together));
    }
  });
});

describe("two Teams", () => {
  it("B's Scan fixes only B's Finding, and B reads none of A's rows", async () => {
    const [a, b] = [await newTeam(), await newTeam()];
    await findings.reconcile(scanOf(a, { id: "scan-1", started_at: "2026-11-24T09:00:00Z" }));
    await findings.reconcile(scanOf(b, { id: "scan-1", started_at: "2026-11-24T09:00:00Z" }));
    const [aFinding] = await findings.list(a);

    const outcome = await findings.reconcile(
      scanOf(b, { id: "scan-2", started_at: "2026-11-24T10:00:00Z", observations: [] }),
    );

    const [bFinding] = await findings.list(b);
    expect(outcome.fixed).toEqual([bFinding!.id]);
    expect(bFinding!.status).toBe("fixed");
    expect((await findings.list(a)).map((f) => [f.id, f.status])).toEqual([[aFinding!.id, "open"]]);

    const seenByB = await stored(b);
    for (const rows of Object.values(seenByB)) {
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.team_id))).toEqual(new Set([b]));
    }
    expect((await findings.list(b)).map((f) => f.team)).toEqual([b]);
    expect(await findings.history(b, aFinding!.id)).toEqual([]);
  });
});
