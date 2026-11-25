// The demo seed (`pnpm --filter @warden/server seed <team>`): the demo Findings from `@warden/contracts/demo` in one
// Team, through the Findings module's reconcile, report and named decisions. Each case uses a Team of its own in the
// suite's shared database; the last ones run the script as its own process.
import { randomUUID } from "node:crypto";
import type { Finding } from "@warden/contracts";
import { DEMO_OBSERVATIONS, demoRuns } from "@warden/contracts/demo";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { seedDemoFindings, seedRefusal } from "../src/seed.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { runInServer } from "./databases.ts";
import { seedTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;

beforeAll(() => {
  // A seed holds one connection for its lock and uses another for its work: two at once need four.
  pool = createPool(
    createLogger(() => {}),
    {
      user: "warden_app",
      database: inject("testDatabase"),
      max: 4,
    },
  );
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
});

afterAll(() => pool.end());

const newTeam = () => `org_${randomUUID()}`;
const NOW = new Date("2026-11-24T12:00:00Z");
const DEMO_COUNT = Object.keys(DEMO_OBSERVATIONS).length;

const count = (list: readonly Finding[], key: (f: Finding) => string) =>
  Object.fromEntries(
    [...new Set(list.map(key))]
      .sort()
      .map((value) => [value, list.filter((f) => key(f) === value).length]),
  );

async function teamWith(people: [string, "member" | "lead" | "admin"][]) {
  const team = newTeam();
  await seedTeam(withTeam, team, people);
  return team;
}

describe("seedRefusal", () => {
  it("refuses unless WARDEN_SEED_DEMO is set", () => {
    expect(seedRefusal({ PGHOST: "127.0.0.1", PGDATABASE: "warden" })).toMatch(
      /Set WARDEN_SEED_DEMO/,
    );
    expect(
      seedRefusal({ PGHOST: "127.0.0.1", PGDATABASE: "warden", WARDEN_SEED_DEMO: "" }),
    ).toMatch(/Set WARDEN_SEED_DEMO/);
  });

  it("takes any value on a local database: 127.0.0.1, localhost or ::1, with no password", () => {
    for (const PGHOST of ["127.0.0.1", "localhost", "::1", undefined]) {
      expect(seedRefusal({ PGHOST, PGDATABASE: "warden", WARDEN_SEED_DEMO: "1" })).toBeUndefined();
    }
  });

  it("elsewhere, or with a password (the Cloud SQL Auth Proxy listens locally), needs the database's name", () => {
    const hosted = [
      { PGHOST: "/cloudsql/project:europe-west1:warden-db" },
      { PGHOST: "10.0.0.5" },
      { PGHOST: "127.0.0.1", PGPASSWORD: "x" },
    ];
    for (const where of hosted) {
      expect(
        seedRefusal({ ...where, PGDATABASE: "warden_preview", WARDEN_SEED_DEMO: "1" }),
      ).toMatch(/WARDEN_SEED_DEMO must name the database, warden_preview/);
      expect(
        seedRefusal({ ...where, PGDATABASE: "warden_preview", WARDEN_SEED_DEMO: "warden_preview" }),
      ).toBeUndefined();
    }
  });

  it("never seeds the live database, warden, on a hosted server", () => {
    expect(
      seedRefusal({
        PGHOST: "127.0.0.1",
        PGPASSWORD: "x",
        PGDATABASE: "warden",
        WARDEN_SEED_DEMO: "warden",
      }),
    ).toMatch(/live database/);
  });
});

describe("seedDemoFindings", () => {
  it("fills a Team with the demo Findings across modules, Asset kinds, Severities and every Status", async () => {
    const team = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    const result = await seedDemoFindings({ pool, team, now: NOW });

    const list = await findings.list(team);
    expect(result).toEqual({ kind: "seeded", findings: DEMO_COUNT });
    expect(list).toHaveLength(DEMO_COUNT);
    expect(count(list, (f) => f.status)).toEqual({
      accepted: 1,
      false_positive: 1,
      fixed: 2,
      open: 7,
    });
    const open = list.filter((f) => f.status === "open");
    expect(count(open, (f) => f.severity)).toEqual({ critical: 2, high: 3, low: 1, medium: 1 });
    expect(count(list, (f) => f.module)).toEqual({ guard: 6, patch: 5 });
    expect(Object.keys(count(list, (f) => f.asset.kind))).toEqual([
      "agent_session",
      "device",
      "product",
      "repo",
    ]);
    expect(list.filter((f) => f.unconfirmed_fix !== null)).toHaveLength(1);
  });

  it("decides the Accepted and False positive ones as the Team's oldest Admin or Lead, for 90 days", async () => {
    const team = await teamWith([
      ["user_member", "member"],
      ["user_lead", "lead"],
    ]);

    await seedDemoFindings({ pool, team, now: NOW });

    const decided = (await findings.list(team)).filter((f) =>
      ["accepted", "false_positive"].includes(f.status),
    );
    expect(decided).toHaveLength(2);
    for (const finding of decided) {
      const last = (await findings.history(team, finding.id)).at(-1);
      expect(last?.cause).toEqual({ kind: "person", id: "user_lead" });
      expect(last?.reason).toMatch(/^Demo seed: /);
    }
    const accepted = decided.find((f) => f.status === "accepted");
    expect(Date.parse(accepted?.accepted_until ?? "")).toBe(Date.parse("2027-02-22T12:00:00Z"));
  });

  it("run again, says the Team is already seeded and changes nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemoFindings({ pool, team, now: NOW });
    const before = await findings.list(team);

    expect(await seedDemoFindings({ pool, team, now: new Date() })).toEqual({
      kind: "already_seeded",
      findings: DEMO_COUNT,
    });
    expect(await findings.list(team)).toEqual(before);
  });

  it("two runs at once: one seeds, the other finds it seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const results = await Promise.all([
      seedDemoFindings({ pool, team, now: NOW }),
      seedDemoFindings({ pool, team, now: new Date(NOW.getTime() + 1000) }),
    ]);

    expect(results.map((r) => r.kind).sort()).toEqual(["already_seeded", "seeded"]);
    expect(await findings.list(team)).toHaveLength(DEMO_COUNT);
  });

  it("refuses a Team that has Findings of its own, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans } = demoRuns(team, NOW);
    await findings.reconcile({ ...scans[0]!, id: "a-real-scan" });
    const before = await findings.list(team);

    expect(await seedDemoFindings({ pool, team, now: NOW })).toEqual({
      kind: "other_findings",
      findings: before.length,
    });
    expect(await findings.list(team)).toEqual(before);
  });

  it("says a seed that was cut short doesn't match, rather than calling it seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans } = demoRuns(team, NOW);
    await findings.reconcile(scans[0]!);

    const result = await seedDemoFindings({ pool, team, now: NOW });

    expect(result.kind).toBe("mismatch");
    expect(result.kind === "mismatch" && result.problems).toContain("lodash: missing (want open)");
  });

  it("refuses a Team Warden doesn't have, and one with no Admin or Lead, writing nothing", async () => {
    const missing = newTeam();
    expect(await seedDemoFindings({ pool, team: missing, now: NOW })).toEqual({ kind: "no_team" });
    expect(await findings.list(missing)).toEqual([]);

    const membersOnly = await teamWith([["user_member", "member"]]);
    expect(await seedDemoFindings({ pool, team: membersOnly, now: NOW })).toEqual({
      kind: "no_lead",
    });
    expect(await findings.list(membersOnly)).toEqual([]);
  });
});

describe("pnpm seed", () => {
  const env = () => ({
    PGUSER: "warden_app",
    PGDATABASE: inject("testDatabase"),
    WARDEN_SEED_DEMO: "1",
  });

  it("seeds the Team named on the command line as warden_app, and says what it did", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], env());

    expect(output).toContain(`"message":"demo Findings seeded"`);
    expect(code).toBe(0);
    expect(await findings.list(team)).toHaveLength(DEMO_COUNT);
  });

  it("exits 1 before connecting without WARDEN_SEED_DEMO", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], {
      ...env(),
      WARDEN_SEED_DEMO: "",
    });

    expect(code).toBe(1);
    expect(output).toContain("Set WARDEN_SEED_DEMO");
    expect(await findings.list(team)).toEqual([]);
  });

  it("exits 1 naming what's wrong: no Team named, a Team Warden doesn't have, or other Findings", async () => {
    const unnamed = await runInServer(["node", "src/seed.ts"], env());
    expect(unnamed.code).toBe(1);
    expect(unnamed.output).toContain("Name the Team to seed");

    const missing = await runInServer(["node", "src/seed.ts", newTeam()], env());
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Open Warden as the Team's Admin first");

    const team = await teamWith([["user_admin", "admin"]]);
    await findings.reconcile({ ...demoRuns(team, NOW).scans[0]!, id: "a-real-scan" });
    const other = await runInServer(["node", "src/seed.ts", team], env());
    expect(other.code).toBe(1);
    expect(other.output).toContain("has Findings of its own");
  });

  it("refuses a database role that can bypass row-level security", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], {
      ...env(),
      PGUSER: "warden_migrate",
    });

    expect(code).toBe(1);
    expect(output).toContain("can bypass row-level security");
    expect(await findings.list(team)).toEqual([]);
  });
});
