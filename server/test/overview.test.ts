// Findings.overview (story 10): the numbers behind the Overview's trend. Each Finding is written with its history rows
// at chosen times, so the 30-day period has a before and a during; each test has a Team of its own in the suite's
// shared database. Scans go through the Findings module, as a module's would.
import { randomUUID } from "node:crypto";
import { fingerprint, type Finding, type Scan, type SpotRun, type Status } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { OVERVIEW_PERIOD_DAYS } from "../src/findings/overview.ts";
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

afterAll(() => pool.end());

const DAY = 24 * 3600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
const overview = (team: string) => findings.overview(team, OVERVIEW_PERIOD_DAYS);

async function newTeam() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [["user_admin", "admin"]]);
  return team;
}

const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;
const ENV = "guard/agent-can-read-env";

/** One history row: how many days ago it was written, and the Status before (null: it opened the Finding) and after. */
type Change = [days: number, before: Status | null, after: Status];

/**
 * A Finding stored through `toRow` as `status` now (with `fields`), each at a path of its own so none share a problem,
 * and `changes` as its history, each row written at its chosen time. Returns its id.
 */
async function given(
  team: string,
  status: Status,
  changes: Change[],
  fields: Partial<Finding> = {},
): Promise<string> {
  const id = randomUUID();
  const location = { kind: "file", path: `config/${id}.json` } as const;
  const finding: Finding = {
    id,
    team,
    asset: repo,
    module: "guard",
    rule_id: ENV,
    fingerprint: fingerprint(ENV, location),
    location,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status,
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...fields,
  };
  await withTeam(team, async (tx) => {
    await tx.insertInto("findings").values(toRow(finding)).execute();
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
          actor_id: "scan-0",
          reason: "written by the test",
        })
        .execute();
    }
  });
  return id;
}

const scanAt = (team: string, started_at: string): Scan => ({
  id: `scan-${randomUUID()}`,
  team,
  module: "guard",
  started_at,
  assets: [repo],
  rules: [ENV],
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
    expect((await overview(team)).last_scan_at).toBeNull();
  });

  it("is the latest Scan's started_at after two Scans", async () => {
    const team = await newTeam();
    await findings.reconcile(scanAt(team, "2026-11-20T09:00:00Z"));
    await findings.reconcile(scanAt(team, "2026-11-22T09:30:00Z"));
    expect((await overview(team)).last_scan_at).toBe("2026-11-22T09:30:00Z");
  });

  it("stays null with only a Spot run", async () => {
    const team = await newTeam();
    await findings.report(spotRunAt(team, "2026-11-22T09:30:00Z"));
    expect((await overview(team)).last_scan_at).toBeNull();
  });
});

describe("Findings.overview: Open at the start and now", () => {
  it("counts one opened 40 days ago and still Open in both, and one opened 10 days ago only now", async () => {
    const team = await newTeam();
    await given(team, "open", [[40, null, "open"]]);
    await given(team, "open", [[10, null, "open"]]);

    const answer = await overview(team);

    expect(answer.open_at_start).toBe(1);
    expect(answer.open_now).toBe(2);
  });

  it("reads the start from each Finding's latest row at or before it: one fixed 35 days ago wasn't Open then", async () => {
    const team = await newTeam();
    await given(team, "fixed", [
      [40, null, "open"],
      [35, "open", "fixed"],
    ]);

    const answer = await overview(team);

    expect(answer.open_at_start).toBe(0);
    expect(answer.open_now).toBe(0);
    expect(answer.fix_rate).toEqual({ fixed: 0, of: 0 });
  });

  it("is zero everywhere, with no Findings, for a Team with none", async () => {
    const team = await newTeam();
    expect(await overview(team)).toEqual({
      last_scan_at: null,
      has_findings: false,
      open_at_start: 0,
      open_now: 0,
      fix_rate: { fixed: 0, of: 0 },
    });
  });

  it("says the Team has Findings when every one is Accepted and old, though nothing counts", async () => {
    const team = await newTeam();
    await given(
      team,
      "accepted",
      [
        [60, null, "open"],
        [50, "open", "accepted"],
      ],
      { accepted_reason: "Only in a test fixture", accepted_until: "2027-06-01T00:00:00Z" },
    );

    expect(await overview(team)).toEqual({
      last_scan_at: null,
      has_findings: true,
      open_at_start: 0,
      open_now: 0,
      fix_rate: { fixed: 0, of: 0 },
    });
  });
});

describe("Findings.overview: the Fix rate", () => {
  it("counts a Finding a Scan fixed during the period, still Fixed, with no Unconfirmed fix, in fixed and of", async () => {
    const team = await newTeam();
    await given(team, "fixed", [
      [40, null, "open"],
      [5, "open", "fixed"],
    ]);
    await given(team, "open", [[10, null, "open"]]);

    expect((await overview(team)).fix_rate).toEqual({ fixed: 1, of: 2 });
  });

  it("doesn't count in fixed a Finding with an Unconfirmed fix", async () => {
    const team = await newTeam();
    const candidate = await given(team, "open", [[5, null, "open"]]);
    await given(
      team,
      "fixed",
      [
        [40, null, "open"],
        [5, "open", "fixed"],
      ],
      { unconfirmed_fix: { candidates: [candidate] } },
    );

    expect((await overview(team)).fix_rate).toEqual({ fixed: 0, of: 2 });
  });

  it("never counts a Finding merged into another (moved_to set), in fixed or in of", async () => {
    const team = await newTeam();
    const kept = await given(team, "open", [
      [40, null, "open"],
      [6, "open", "fixed"],
      [3, "fixed", "open"],
    ]);
    await given(
      team,
      "fixed",
      [
        [6, null, "open"],
        [3, "open", "fixed"],
      ],
      { moved_to: kept },
    );

    expect((await overview(team)).fix_rate).toEqual({ fixed: 0, of: 1 });
  });

  it("doesn't count in fixed a Finding fixed then reopened during the period", async () => {
    const team = await newTeam();
    await given(team, "open", [
      [40, null, "open"],
      [8, "open", "fixed"],
      [4, "fixed", "open"],
    ]);

    expect((await overview(team)).fix_rate).toEqual({ fixed: 0, of: 1 });
  });

  it("counts once in of a Finding Open at the start and reopened during the period", async () => {
    const team = await newTeam();
    await given(team, "open", [
      [40, null, "open"],
      [20, "open", "fixed"],
      [10, "fixed", "open"],
    ]);

    const answer = await overview(team);

    expect(answer.fix_rate).toEqual({ fixed: 0, of: 1 });
    expect(answer.open_at_start).toBe(1);
  });

  it("doesn't count a Finding Accepted all through the period, even once a Scan fixes it", async () => {
    const team = await newTeam();
    await given(team, "fixed", [
      [50, null, "open"],
      [45, "open", "accepted"],
      [5, "accepted", "fixed"],
    ]);

    expect((await overview(team)).fix_rate).toEqual({ fixed: 0, of: 0 });
  });
});
