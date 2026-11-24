// The demo seed (`pnpm --filter @warden/server seed <team>`): a handful of Findings across modules, Severities and
// Statuses in one Team, through the Findings module's reconcile, report and named decisions. Each case uses a Team of
// its own in the suite's shared database; one runs the script as its own process on a fresh database.
import { randomUUID } from "node:crypto";
import type { Finding } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { seedDemoFindings } from "../src/seed.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs, runInServer } from "./databases.ts";
import { seedTeam } from "./helpers.ts";

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

afterAll(() => pool.end());

const newTeam = () => `org_${randomUUID()}`;
const NOW = new Date("2026-11-24T12:00:00Z");

const count = (list: readonly Finding[], key: (f: Finding) => string) =>
  Object.fromEntries(
    [...new Set(list.map(key))]
      .sort()
      .map((value) => [value, list.filter((f) => key(f) === value).length]),
  );

describe("seedDemoFindings", () => {
  it("fills a Team with Findings across modules, Asset kinds, Severities and every Status", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    const result = await seedDemoFindings({ withTeam, findings, team, now: NOW });

    const list = await findings.list(team);
    expect(result).toEqual({ kind: "seeded", findings: list.length });
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

  it("decides the Accepted and False positive ones as the Team's oldest Admin or Lead, saying it's the seed", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [
      ["user_member", "member"],
      ["user_lead", "lead"],
    ]);

    await seedDemoFindings({ withTeam, findings, team, now: NOW });

    const decided = (await findings.list(team)).filter((f) =>
      ["accepted", "false_positive"].includes(f.status),
    );
    for (const finding of decided) {
      const last = (await findings.history(team, finding.id)).at(-1);
      expect(last?.cause).toEqual({ kind: "person", id: "user_lead" });
      expect(last?.reason).toMatch(/^Demo seed: /);
    }
    expect(decided).toHaveLength(2);
    // Accepted for 90 days from the seed's `now`.
    const accepted = decided.find((f) => f.status === "accepted");
    expect(Date.parse(accepted?.accepted_until ?? "")).toBe(Date.parse("2027-02-22T12:00:00Z"));
  });

  it("leaves a Team that already has Findings as it is", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [["user_admin", "admin"]]);
    await seedDemoFindings({ withTeam, findings, team, now: NOW });
    const before = await findings.list(team);

    expect(await seedDemoFindings({ withTeam, findings, team, now: NOW })).toEqual({
      kind: "has_findings",
      findings: before.length,
    });
    expect(await findings.list(team)).toEqual(before);
  });

  it("refuses a Team Warden doesn't have, and one with no Admin or Lead, writing nothing", async () => {
    const missing = newTeam();
    expect(await seedDemoFindings({ withTeam, findings, team: missing, now: NOW })).toEqual({
      kind: "no_team",
    });
    expect(await findings.list(missing)).toEqual([]);

    const membersOnly = newTeam();
    await seedTeam(withTeam, membersOnly, [["user_member", "member"]]);
    expect(await seedDemoFindings({ withTeam, findings, team: membersOnly, now: NOW })).toEqual({
      kind: "no_lead",
    });
    expect(await findings.list(membersOnly)).toEqual([]);
  });
});

describe("pnpm seed", () => {
  it("seeds the Team named on the command line as warden_app, and says what it did", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], {
      PGUSER: "warden_app",
      PGDATABASE: inject("testDatabase"),
    });

    expect(output).toContain(`"message":"demo Findings seeded"`);
    expect(code).toBe(0);
    expect(await findings.list(team)).toHaveLength(11);
  });

  it("exits 1 naming what's wrong: no Team named, or a Team Warden doesn't have", async () => {
    const env = { PGUSER: "warden_app", PGDATABASE: inject("testDatabase") };

    const unnamed = await runInServer(["node", "src/seed.ts"], env);
    expect(unnamed.code).toBe(1);
    expect(unnamed.output).toContain("Name the Team to seed");

    const missing = await runInServer(["node", "src/seed.ts", newTeam()], env);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Open Warden as the Team's Admin first");
  });

  it("refuses a database role that can bypass row-level security", async () => {
    const team = newTeam();
    await seedTeam(withTeam, team, [["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], {
      PGUSER: "warden_migrate",
      PGDATABASE: inject("testDatabase"),
    });

    expect(code).toBe(1);
    expect(output).toContain("can bypass row-level security");
    expect(await findings.list(team)).toEqual([]);
  });
});
