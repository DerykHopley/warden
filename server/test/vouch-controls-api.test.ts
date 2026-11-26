// Stories 2, 3 and 10 at the API (spec #341, slice 2b): every person in the Team reads each judged Control of VDA ISA
// 2027.1 with its Verdict, reason and evidence (`GET /api/vouch/catalogues/:id/controls` and `.../controls/:ref`),
// worked out on read from the Team's Findings, Scan coverage and Judge Spot runs in the last 30 days, and its held
// Assets through the real `TeamAssets`. Through the real app on the suite's shared database, each case with Teams of
// its own; Scans and Spot runs go through the Findings module, as a module's would.
import { randomUUID } from "node:crypto";
import {
  ControlsBody,
  ControlVerdict,
  type Asset,
  type Observation,
  type RuleId,
  type Scan,
} from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { VDA_ISA_2027_1 } from "../src/modules/vouch/catalogue.ts";
import { vouchRoutes } from "../src/modules/vouch/routes.ts";
import { createTeamAssets, type TeamAssets } from "../src/modules/vouch/team-assets.ts";
import { createTeamCatalogues, type TeamCatalogues } from "../src/modules/vouch/team-catalogues.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  ADMIN,
  call,
  linkRepos,
  newTeam,
  repoRef,
  seedProduct,
  testApp,
  testKey,
} from "./helpers.ts";

const LEAD = "user_lead";
const MEMBER = "user_member";
const ISA = "vda-isa-2027.1";
const CONTROLS = `/api/vouch/catalogues/${ISA}/controls`;

const DAY = 24 * 3600_000;
const START = Math.floor(Date.now() / 1000) * 1000;
/** A whole-second time `days` before the test file started. */
const daysAgo = (days: number) => new Date(START - days * DAY);

const app_: Asset = { kind: "repo", ref: repoRef("app") };
const api: Asset = { kind: "repo", ref: repoRef("api") };
const UNAPPROVED: RuleId = "guard/unapproved-ai-tool";
const MCP: RuleId = "guard/mcp-server-unpinned";
const SECRET: RuleId = "guard/secret-in-repo";
const SETTINGS: RuleId = "guard/secret-in-agent-settings";
const VULN: RuleId = "patch/known-vulnerability";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let repoAssets: RepoAssets;
let teamCatalogues: TeamCatalogues;
let app: Hono<AppEnv>;
/** Every read the Vouch routes made of a store since the case began. */
let reads: string[];

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
  repoAssets = createRepoAssets({ withTeam });
  teamCatalogues = createTeamCatalogues({ withTeam });
  const teamAssets = createTeamAssets({ repoAssets, products: createProducts({ withTeam }) });
  // The real stores, each read noted first, so a case can see that a refusal read none.
  const noted =
    <A extends unknown[], R>(name: string, read: (...args: A) => R) =>
    (...args: A): R => {
      reads.push(name);
      return read(...args);
    };
  ({ app } = testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      vouchRoutes({
        teamCatalogues: {
          ...teamCatalogues,
          list: noted("teamCatalogues.list", teamCatalogues.list),
        },
        catalogues: [VDA_ISA_2027_1],
        findings: {
          listByRules: noted("listByRules", findings.listByRules),
          coverageSince: noted("coverageSince", findings.coverageSince),
          lastSpotRunAt: noted("lastSpotRunAt", findings.lastSpotRunAt),
        },
        teamAssets: { held: noted("teamAssets.held", teamAssets.held) } satisfies TeamAssets,
      }),
    ],
  }));
});

beforeEach(() => {
  reads = [];
});

afterAll(() => pool.end());

/** A Team with an Admin, a Lead and a Member. */
const team = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);

const get = (teamId: string, path: string, as = MEMBER) =>
  call(app, key, "GET", path, { as, teamId });

const readControls = async (teamId: string, as = MEMBER) => {
  const res = await get(teamId, CONTROLS, as);
  expect(res.status).toBe(200);
  return ControlsBody.parse(res.body);
};

const control = (body: ControlsBody, ref: string) => {
  const found = body.controls.find((entry) => entry.ref === ref);
  if (found === undefined) throw new Error(`${CONTROLS} has no ${ref}`);
  return found;
};

let titles = 0;
const observation = (asset: Asset, rule_id: RuleId): Observation => ({
  asset,
  rule_id,
  location: { kind: "file", path: `.claude/${randomUUID()}.json` },
  severity: "high",
  title: `A problem the test made, number ${++titles}`,
  evidence: { summary: "written by the test" },
});

const scan = (
  teamId: string,
  days: number,
  assets: Asset[],
  rules: RuleId[],
  observations: Observation[] = [],
): Scan => ({
  id: `scan-${randomUUID()}`,
  team: teamId,
  module: "guard",
  started_at: daysAgo(days).toISOString(),
  assets,
  rules,
  observations,
});

const judgeSpotRun = (teamId: string, days: number) =>
  findings.report({
    id: `spot-${randomUUID()}`,
    team: teamId,
    module: "guard",
    started_at: daysAgo(days).toISOString(),
    observations: [],
  });

/**
 * A Team holding Repos app and api and one Product. A Guard Scan two days ago covered both Repos for 1.3.3's and
 * 4.1.3's Rules and found three secrets in the repos: the ones on app and api stay Open, a second on api is Accepted.
 * So 1.3.3 is evidenced, and 4.1.3 partly (`guard/secret-in-repo` partly, `guard/secret-in-agent-settings`
 * evidenced). Nothing covered 1.3.4's Rules, and a Judge Spot run ran three days ago.
 */
async function seededTeam() {
  const teamId = await team();
  await linkRepos(repoAssets, teamId, [app_.ref, api.ref]);
  await seedProduct(withTeam, teamId, { name: "Shop" });
  const onApp = observation(app_, SECRET);
  const onApi = observation(api, SECRET);
  const toAccept = observation(api, SECRET);
  await findings.reconcile(
    scan(teamId, 2, [app_, api], [UNAPPROVED, MCP, SECRET, SETTINGS], [onApp, onApi, toAccept]),
  );
  await judgeSpotRun(teamId, 3);
  const all = await findings.list(teamId);
  const from = ({ title }: Observation) => {
    const found = all.find((finding) => finding.title === title);
    if (found === undefined) throw new Error(`no Finding titled ${title}`);
    return found;
  };
  const accepted = from(toAccept);
  await findings.accept(teamId, accepted.id, {
    actor: { kind: "person", id: LEAD },
    reason: "Rotated next sprint",
    until: new Date(Date.now() + 7 * DAY).toISOString(),
  });
  return { teamId, open: [from(onApp), from(onApi)], accepted, ids: all.map(({ id }) => id) };
}

/** A rule's evidence with its time as milliseconds, for comparing. */
const ruleTimes = (entry: ControlVerdict) =>
  entry.evidence.rules.map(({ last_covered_at, ...rest }) => ({
    ...rest,
    last_covered_at: last_covered_at === null ? null : Date.parse(last_covered_at),
  }));

describe("GET /api/vouch/catalogues/:id/controls: each judged Control's Verdict, reason and evidence", () => {
  it("answers a Member the four Controls in order, each with the Verdict and reason its state gives (story 2)", async () => {
    const { teamId } = await seededTeam();

    const body = await readControls(teamId, MEMBER);

    expect(body.catalogue).toBe(ISA);
    expect(body.controls.map(({ ref, verdict, reason }) => ({ ref, verdict, reason }))).toEqual([
      {
        ref: "1.3.3",
        verdict: "evidenced",
        reason: "Every Repo scanned in the last 30 days, nothing Open",
      },
      { ref: "1.3.4", verdict: "not_evidenced", reason: "No Scan in the last 30 days" },
      { ref: "4.1.3", verdict: "partly_evidenced", reason: "2 Open Findings on 2 Repos" },
      {
        ref: "5.2.4",
        verdict: "evidenced",
        reason: `Judge Spot run on ${daysAgo(3).toISOString().slice(0, 10)}`,
      },
    ]);
    // The Catalogue's own text for each, unchanged.
    expect(
      body.controls.map(({ ref, question, iso_27001 }) => ({ ref, question, iso_27001 })),
    ).toEqual(
      VDA_ISA_2027_1.judgedControls.map(({ id, question, iso_27001 }) => ({
        ref: id,
        question,
        iso_27001,
      })),
    );
    expect(Date.parse(control(body, "5.2.4").evidence.judge_spot_run_at ?? "")).toBe(
      daysAgo(3).getTime(),
    );
  });

  it("names 4.1.3's Rules with their last coverage and Asset counts, and its Open Findings by id, not the Accepted one (story 3)", async () => {
    const { teamId, open, accepted } = await seededTeam();

    const entry = control(await readControls(teamId), "4.1.3");

    expect(ruleTimes(entry)).toEqual([
      {
        rule_id: SECRET,
        asset_kind: "repo",
        last_covered_at: daysAgo(2).getTime(),
        assets_covered: 2,
        assets_held: 2,
      },
      {
        rule_id: SETTINGS,
        asset_kind: "repo",
        last_covered_at: daysAgo(2).getTime(),
        assets_covered: 2,
        assets_held: 2,
      },
    ]);
    expect(entry.evidence.judge_spot_run_at).toBeNull();
    expect(entry.evidence.open_findings).toEqual(
      [...open]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(({ id, rule_id, title, severity, asset }) => ({
          id,
          rule_id,
          title,
          severity,
          asset,
        })),
    );
    expect(entry.evidence.open_findings.map(({ id }) => id)).not.toContain(accepted.id);
  });

  it("reads every Control not evidenced for a Team with no Scan and no Spot run", async () => {
    const teamId = await team();

    const body = await readControls(teamId);

    expect(body.controls.map(({ ref, verdict }) => [ref, verdict])).toEqual([
      ["1.3.3", "not_evidenced"],
      ["1.3.4", "not_evidenced"],
      ["4.1.3", "not_evidenced"],
      ["5.2.4", "not_evidenced"],
    ]);
    expect(control(body, "5.2.4").reason).toBe("No Judge Spot run in the last 30 days");
    expect(control(body, "5.2.4").evidence).toEqual({
      rules: [],
      judge_spot_run_at: null,
      open_findings: [],
    });
  });

  it("counts a held Repo no Scan covered, from the wired TeamAssets: 4.1.3 partly evidenced, one more held than covered", async () => {
    const teamId = await team();
    await linkRepos(repoAssets, teamId, [app_.ref, api.ref]);
    await seedProduct(withTeam, teamId, { name: "Shop" });
    await findings.reconcile(scan(teamId, 1, [app_, api], [SECRET]));
    await findings.reconcile(scan(teamId, 1, [app_], [SETTINGS]));

    const body = await readControls(teamId);
    const entry = control(body, "4.1.3");

    expect(entry).toMatchObject({
      verdict: "partly_evidenced",
      reason: "1 of 2 Repos not scanned in the last 30 days",
    });
    expect(
      entry.evidence.rules.map(({ rule_id, assets_covered, assets_held }) => [
        rule_id,
        assets_covered,
        assets_held,
      ]),
    ).toEqual([
      [SECRET, 2, 2],
      [SETTINGS, 1, 2],
    ]);
    // The Team's one Product is the Asset a patch/ Rule is held on.
    expect(control(body, "1.3.4").evidence.rules.find(({ rule_id }) => rule_id === VULN)).toEqual({
      rule_id: VULN,
      asset_kind: "product",
      last_covered_at: null,
      assets_covered: 0,
      assets_held: 1,
    });
  });

  it("answers a Catalogue the Team has off with `on: false`, and with `on: true` once turned on", async () => {
    const teamId = await team();

    expect((await readControls(teamId)).on).toBe(false);

    await teamCatalogues.set(teamId, { catalogue: ISA, on: true, setBy: ADMIN });
    const on = await readControls(teamId);

    expect(on.on).toBe(true);
    expect(on.controls).toHaveLength(4);
  });
});

describe("GET /api/vouch/catalogues/:id/controls/:ref: one Control", () => {
  it("answers 4.1.3 as the list does", async () => {
    const { teamId } = await seededTeam();
    const listed = control(await readControls(teamId), "4.1.3");

    const res = await get(teamId, `${CONTROLS}/4.1.3`);

    expect(res.status).toBe(200);
    expect(ControlVerdict.parse(res.body)).toEqual(listed);
  });

  it.each([
    ["a Control the Catalogue doesn't judge", "1.6.1"],
    ["a Control the Catalogue doesn't have", "9.9.9"],
    ["a ref that isn't dotted numbers", "abc"],
    ["a ref short of a Control", "1.3"],
    ["a ref holding a NUL", "4.1.3%00"],
  ])("answers 404 `No such Control` for %s, reading no store", async (_name, ref) => {
    const teamId = await team();

    const res = await get(teamId, `${CONTROLS}/${ref}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Control" });
    expect(reads).toEqual([]);
  });

  it.each([
    ["the list of a Catalogue Warden doesn't have", "/api/vouch/catalogues/iso-27001/controls"],
    [
      "one Control of a Catalogue Warden doesn't have",
      "/api/vouch/catalogues/iso-27001/controls/4.1.3",
    ],
    ["a Catalogue id holding a NUL", `/api/vouch/catalogues/${ISA}%00/controls`],
  ])("answers 404 `No such Catalogue` for %s, reading no store", async (_name, path) => {
    const teamId = await team();

    const res = await get(teamId, path);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Catalogue" });
    expect(reads).toEqual([]);
  });

  it("answers no session the app's 401", async () => {
    const res = await app.request(CONTROLS);

    expect(res.status).toBe(401);
  });
});

describe("Teams apart (story 10)", () => {
  it("reads Team B every Control not evidenced, with none of Team A's Findings in its evidence", async () => {
    const { ids } = await seededTeam();
    const teamB = await team();

    const res = await get(teamB, CONTROLS);
    const body = ControlsBody.parse(res.body);

    expect(body.controls.map(({ verdict }) => verdict)).toEqual([
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
    ]);
    expect(body.controls.flatMap(({ evidence }) => evidence.open_findings)).toEqual([]);
    expect(ids).not.toHaveLength(0);
    for (const id of ids) expect(res.text).not.toContain(id);
  });
});
