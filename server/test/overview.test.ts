// Findings.overview (story 10): the numbers behind the Overview's trend. Each Finding is written with its history rows
// at chosen times, so the 30-day period has a before and a during; each test has a Team of its own in the suite's
// shared database. Scans go through the Findings module, as a module's would.
import { randomUUID } from "node:crypto";
import type { Scan, SpotRun, Status } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
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

afterAll(() => pool.end());

const DAY = 24 * 3600_000;
const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * DAY);
/** The start of the 30-day period. */
const since = daysAgo(30);

async function newTeam() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [["user_admin", "admin"]]);
  return team;
}

/** One history row: how many days ago it was written, and the Status before (null: it opened the Finding) and after. */
type Change = [days: number, before: Status | null, after: Status];

/**
 * A Finding stored as `status` now, with `changes` as its history, each written at its chosen time. Returns its id.
 */
async function finding(
  team: string,
  status: Status,
  changes: Change[],
  extra: { unconfirmedFix?: string[]; movedTo?: string } = {},
) {
  const id = randomUUID();
  await withTeam(team, async (tx) => {
    await tx
      .insertInto("findings")
      .values({
        team_id: team,
        id,
        asset_kind: "repo",
        asset_ref: "https://github.com/example/app",
        module: "guard",
        rule_id: "guard/agent-can-read-env",
        fingerprint: `guard/agent-can-read-env|file:${id}`,
        location: JSON.stringify({ kind: "file", path: id }),
        severity: "high",
        title: "The agent can read .env files",
        evidence: JSON.stringify({ summary: "permissions.allow lets the agent read .env" }),
        control: null,
        status,
        unconfirmed_fix: extra.unconfirmedFix
          ? JSON.stringify({ candidates: extra.unconfirmedFix })
          : null,
        accepted_reason: null,
        accepted_until: null,
        first_seen_scan: "scan-1",
        last_seen_scan: "scan-1",
        moved_to: extra.movedTo ?? null,
      })
      .execute();
    for (const [days, before, after] of changes) {
      await tx
        .insertInto("finding_history")
        .values({
          team_id: team,
          finding_id: id,
          at: daysAgo(days),
          status_before: before,
          status_after: after,
          severity_before: before === null ? null : "high",
          severity_after: "high",
          actor_kind: "scan",
          actor_id: "scan-1",
          reason: "written by the test",
        })
        .execute();
    }
  });
  return id;
}

const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;

const scanAt = (team: string, started_at: string): Scan => ({
  id: `scan-${randomUUID()}`,
  team,
  module: "guard",
  started_at,
  assets: [repo],
  rules: ["guard/agent-can-read-env"],
  observations: [],
});

const spotRunAt = (team: string, started_at: string): SpotRun => ({
  id: `spot-${randomUUID()}`,
  team,
  module: "guard",
  started_at,
  observations: [],
});

describe("Findings.overview: the latest Scan", () => {
  it("is null for a Team with no Scan", async () => {
    const team = await newTeam();
    expect((await findings.overview(team, since)).last_scan_at).toBeNull();
  });

  it("is the latest Scan's started_at after two Scans", async () => {
    const team = await newTeam();
    await findings.reconcile(scanAt(team, "2026-11-20T09:00:00Z"));
    await findings.reconcile(scanAt(team, "2026-11-22T09:30:00Z"));
    expect((await findings.overview(team, since)).last_scan_at).toBe("2026-11-22T09:30:00Z");
  });

  it("stays null with only a Spot run", async () => {
    const team = await newTeam();
    await findings.report(spotRunAt(team, "2026-11-22T09:30:00Z"));
    expect((await findings.overview(team, since)).last_scan_at).toBeNull();
  });
});

describe("Findings.overview: Open at the start and now", () => {
  it("counts one opened 40 days ago and still Open in both, and one opened 10 days ago only now", async () => {
    const team = await newTeam();
    await finding(team, "open", [[40, null, "open"]]);
    await finding(team, "open", [[10, null, "open"]]);

    const overview = await findings.overview(team, since);

    expect(overview.open_at_start).toBe(1);
    expect(overview.open_now).toBe(2);
  });

  it("reads the start from each Finding's latest row at or before it: one fixed 35 days ago wasn't Open then", async () => {
    const team = await newTeam();
    await finding(team, "fixed", [
      [40, null, "open"],
      [35, "open", "fixed"],
    ]);

    const overview = await findings.overview(team, since);

    expect(overview.open_at_start).toBe(0);
    expect(overview.open_now).toBe(0);
    expect(overview.fix_rate).toEqual({ fixed: 0, of: 0 });
  });

  it("is zero everywhere for a Team with no Findings", async () => {
    const team = await newTeam();
    expect(await findings.overview(team, since)).toEqual({
      last_scan_at: null,
      open_at_start: 0,
      open_now: 0,
      fix_rate: { fixed: 0, of: 0 },
    });
  });
});

describe("Findings.overview: the Fix rate", () => {
  it("counts a Finding a Scan fixed during the period, still Fixed, with no Unconfirmed fix, in fixed and of", async () => {
    const team = await newTeam();
    await finding(team, "fixed", [
      [40, null, "open"],
      [5, "open", "fixed"],
    ]);
    await finding(team, "open", [[10, null, "open"]]);

    expect((await findings.overview(team, since)).fix_rate).toEqual({ fixed: 1, of: 2 });
  });

  it("doesn't count in fixed a Finding with an Unconfirmed fix", async () => {
    const team = await newTeam();
    const candidate = await finding(team, "open", [[5, null, "open"]]);
    await finding(
      team,
      "fixed",
      [
        [40, null, "open"],
        [5, "open", "fixed"],
      ],
      { unconfirmedFix: [candidate] },
    );

    expect((await findings.overview(team, since)).fix_rate).toEqual({ fixed: 0, of: 2 });
  });

  it("doesn't count in fixed a Finding merged into another (moved_to set)", async () => {
    const team = await newTeam();
    const kept = await finding(team, "open", [
      [40, null, "open"],
      [6, "open", "fixed"],
      [3, "fixed", "open"],
    ]);
    await finding(
      team,
      "fixed",
      [
        [6, null, "open"],
        [3, "open", "fixed"],
      ],
      { movedTo: kept },
    );

    expect((await findings.overview(team, since)).fix_rate).toEqual({ fixed: 0, of: 2 });
  });

  it("doesn't count in fixed a Finding fixed then reopened during the period", async () => {
    const team = await newTeam();
    await finding(team, "open", [
      [40, null, "open"],
      [8, "open", "fixed"],
      [4, "fixed", "open"],
    ]);

    expect((await findings.overview(team, since)).fix_rate).toEqual({ fixed: 0, of: 1 });
  });

  it("counts once in of a Finding Open at the start and reopened during the period", async () => {
    const team = await newTeam();
    await finding(team, "open", [
      [40, null, "open"],
      [20, "open", "fixed"],
      [10, "fixed", "open"],
    ]);

    const overview = await findings.overview(team, since);

    expect(overview.fix_rate).toEqual({ fixed: 0, of: 1 });
    expect(overview.open_at_start).toBe(1);
  });

  it("doesn't count a Finding Accepted all through the period, even once a Scan fixes it", async () => {
    const team = await newTeam();
    await finding(team, "fixed", [
      [50, null, "open"],
      [45, "open", "accepted"],
      [5, "accepted", "fixed"],
    ]);

    expect((await findings.overview(team, since)).fix_rate).toEqual({ fixed: 0, of: 0 });
  });
});
