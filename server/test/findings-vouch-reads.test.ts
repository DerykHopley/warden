// The Findings reads Vouch's Verdict needs (spec #341, slice 2a; ADR 0005: read-only, each inside `withTeam`):
// `listByRules`, `coverageSince` and `lastSpotRunAt`, answering what a Team's reconciled Scans and Spot runs wrote, and
// nothing of another Team's (story 10). Each test has a Team of its own in the suite's shared database; Scans and Spot
// runs go through the Findings module, as a module's would.
import { randomUUID } from "node:crypto";
import type { Actor, Asset, Observation, RuleId, Scan, SpotRun } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type CoverageEntry, type Findings } from "../src/findings/index.ts";
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
const START = Math.floor(Date.now() / 1000) * 1000;
/** A whole-second time `days` before the test file started. */
const daysAgo = (days: number) => new Date(START - days * DAY);

const app: Asset = { kind: "repo", ref: "https://github.com/example/app" };
const api: Asset = { kind: "repo", ref: "https://github.com/example/api" };
const old: Asset = { kind: "repo", ref: "https://github.com/example/old" };
const shop: Asset = { kind: "product", ref: "product-shop" };
const ENV: RuleId = "guard/agent-can-read-env";
const BASH: RuleId = "guard/blanket-bash-allow";
const SECRET: RuleId = "guard/secret-in-repo";
const VULN: RuleId = "patch/known-vulnerability";
const lead: Actor = { kind: "person", id: "user_lead" };

async function newTeam() {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, [["user_lead", "lead"]]);
  return team;
}

const observation = (asset: Asset, rule_id: RuleId): Observation => ({
  asset,
  rule_id,
  location: { kind: "file", path: `.claude/${randomUUID()}.json` },
  severity: "high",
  title: "A problem the test made",
  evidence: { summary: "written by the test" },
});

function scan(
  team: string,
  days: number,
  assets: Asset[],
  rules: RuleId[],
  observations: Observation[] = [],
  module: Scan["module"] = "guard",
): Scan {
  return {
    id: `scan-${randomUUID()}`,
    team,
    module,
    started_at: daysAgo(days).toISOString(),
    assets,
    rules,
    observations,
  };
}

function spotRun(
  team: string,
  days: number,
  module: SpotRun["module"] = "guard",
  observations: Observation[] = [],
): SpotRun {
  return {
    id: `spot-${randomUUID()}`,
    team,
    module,
    started_at: daysAgo(days).toISOString(),
    observations,
  };
}

/** Each entry as Rule, Asset ref and days ago, for comparing. */
const asDays = (entries: CoverageEntry[]) =>
  entries.map((entry) => [
    entry.rule_id,
    entry.asset.kind,
    entry.asset.ref,
    (START - Date.parse(entry.last_covered_at)) / DAY,
  ]);

/** A Team whose Scan opened a Finding under each of ENV, SECRET and BASH, and whose SECRET one is Accepted. */
async function teamWithFindings() {
  const team = await newTeam();
  await findings.reconcile(
    scan(
      team,
      1,
      [app, api],
      [ENV, SECRET, BASH],
      [observation(app, ENV), observation(api, SECRET), observation(app, BASH)],
    ),
  );
  const byRule = new Map((await findings.list(team)).map((finding) => [finding.rule_id, finding]));
  await findings.accept(team, byRule.get(SECRET)!.id, {
    actor: lead,
    reason: "Rotated next sprint",
    until: new Date(Date.now() + 7 * DAY).toISOString(),
  });
  return { team, env: byRule.get(ENV)!, secret: byRule.get(SECRET)!, bash: byRule.get(BASH)! };
}

describe("Findings.listByRules", () => {
  it("answers only the Findings under the named Rules in the named Statuses, ordered by id", async () => {
    const { team, env, secret } = await teamWithFindings();

    const open = await findings.listByRules(team, { rules: [ENV, SECRET], statuses: ["open"] });
    const either = await findings.listByRules(team, {
      rules: [ENV, SECRET],
      statuses: ["open", "accepted"],
    });

    expect(open.map((finding) => finding.id)).toEqual([env.id]);
    expect(either.map((finding) => finding.id)).toEqual([env.id, secret.id].sort());
    expect(either.find((finding) => finding.id === secret.id)?.status).toBe("accepted");
  });

  it("answers none for no Rules or no Statuses", async () => {
    const { team } = await teamWithFindings();

    expect(await findings.listByRules(team, { rules: [], statuses: ["open"] })).toEqual([]);
    expect(await findings.listByRules(team, { rules: [ENV], statuses: [] })).toEqual([]);
  });
});

describe("Findings.coverageSince", () => {
  it("answers the newest Scan per Rule and Asset since the date, from Scans only", async () => {
    const team = await newTeam();
    await findings.reconcile(scan(team, 40, [app, old], [ENV]));
    await findings.reconcile(scan(team, 10, [app, api], [ENV]));
    await findings.reconcile(scan(team, 5, [app], [ENV, BASH]));
    await findings.reconcile(scan(team, 3, [shop], [VULN], [], "patch"));
    await findings.report(spotRun(team, 1, "guard", [observation(app, ENV)]));

    const since30 = await findings.coverageSince(team, {
      rules: [ENV, BASH, VULN],
      since: daysAgo(30),
    });

    expect(asDays(since30)).toEqual([
      [ENV, "repo", api.ref, 10],
      [ENV, "repo", app.ref, 5],
      [BASH, "repo", app.ref, 5],
      [VULN, "product", shop.ref, 3],
    ]);
  });

  it("lists nothing before the date, and only the named Rules", async () => {
    const team = await newTeam();
    await findings.reconcile(scan(team, 10, [app, api], [ENV, SECRET]));
    await findings.reconcile(scan(team, 5, [app], [ENV]));

    expect(asDays(await findings.coverageSince(team, { rules: [ENV], since: daysAgo(7) }))).toEqual(
      [[ENV, "repo", app.ref, 5]],
    );
    expect(
      asDays(await findings.coverageSince(team, { rules: [ENV], since: daysAgo(10) })),
    ).toEqual([
      [ENV, "repo", api.ref, 10],
      [ENV, "repo", app.ref, 5],
    ]);
    expect(await findings.coverageSince(team, { rules: [ENV], since: daysAgo(4) })).toEqual([]);
    expect(await findings.coverageSince(team, { rules: [], since: daysAgo(30) })).toEqual([]);
  });
});

describe("Findings.lastSpotRunAt", () => {
  it("answers the newest Spot run of the module since the date, never a Scan", async () => {
    const team = await newTeam();
    await findings.report(spotRun(team, 40));
    await findings.report(spotRun(team, 3));
    await findings.report(spotRun(team, 1, "patch"));
    await findings.reconcile(scan(team, 0.5, [app], [ENV]));

    const at = (iso: string | null) => (iso === null ? null : (START - Date.parse(iso)) / DAY);

    expect(at(await findings.lastSpotRunAt(team, { module: "guard", since: daysAgo(30) }))).toBe(3);
    expect(at(await findings.lastSpotRunAt(team, { module: "patch", since: daysAgo(30) }))).toBe(1);
    expect(await findings.lastSpotRunAt(team, { module: "guard", since: daysAgo(2) })).toBeNull();
    expect(await findings.lastSpotRunAt(team, { module: "vouch", since: daysAgo(30) })).toBeNull();
  });
});

describe("the Vouch reads under withTeam(B) (story 10)", () => {
  it("return none of Team A's Findings, coverage or Spot runs", async () => {
    const { team: a } = await teamWithFindings();
    await findings.reconcile(scan(a, 2, [shop], [VULN], [], "patch"));
    await findings.report(spotRun(a, 1));
    const b = await newTeam();
    const rules = [ENV, SECRET, BASH, VULN];

    expect(
      await findings.listByRules(a, { rules, statuses: ["open", "accepted"] }),
    ).not.toHaveLength(0);
    expect(await findings.coverageSince(a, { rules, since: daysAgo(30) })).not.toHaveLength(0);
    expect(await findings.lastSpotRunAt(a, { module: "guard", since: daysAgo(30) })).not.toBeNull();

    expect(await findings.listByRules(b, { rules, statuses: ["open", "accepted"] })).toEqual([]);
    expect(await findings.coverageSince(b, { rules, since: daysAgo(30) })).toEqual([]);
    expect(await findings.lastSpotRunAt(b, { module: "guard", since: daysAgo(30) })).toBeNull();
  });
});
