// The reconcile cases against the real thing (ADR 0005): every case in contracts/reconcile-cases/ runs through
// `createFindings` on the suite's shared database, as warden_app, with Guard's and Patch's move rules wired in as
// the start-up file wires them. Every case runs, case 10's daily expiry included.
import { loadReconcileCases } from "@warden/contracts/reconcile-cases";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { runCase } from "./reconcile-case-runner.ts";

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

describe("the reconcile cases, against createFindings on Postgres", () => {
  for (const { file, case: c } of loadReconcileCases()) {
    it(`${file}: ${c.name}`, async () => {
      const { expected, actual } = await runCase(c, { findings, withTeam });
      expect(actual).toEqual(expected);
    });
  }
});
