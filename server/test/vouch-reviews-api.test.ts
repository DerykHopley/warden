// Stories 4 to 7 and 10 at the API (spec #341, slice 3): a Lead (or an Admin) confirms or overrides a judged Control's
// Verdict (`POST /api/vouch/catalogues/:id/controls/:ref/reviews`), each review a row of the append-only review log, and
// the Controls reads show each Control's reviewed Verdict and review state, and the one-Control read its reviews.
// Through the real app on the suite's shared database, each case with Teams of its own.
import { randomUUID } from "node:crypto";
import {
  ControlDetail,
  ControlsBody,
  type Asset,
  type Observation,
  type RuleId,
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
import { createControlReviews, type ControlReviews } from "../src/modules/vouch/control-reviews.ts";
import { vouchRoutes } from "../src/modules/vouch/routes.ts";
import { createTeamAssets, type TeamAssets } from "../src/modules/vouch/team-assets.ts";
import { createTeamCatalogues } from "../src/modules/vouch/team-catalogues.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, call, linkRepos, newTeam, repoRef, testApp, testKey } from "./helpers.ts";

const LEAD = "user_lead";
const MEMBER = "user_member";
const ISA = "vda-isa-2027.1";
const CONTROLS = `/api/vouch/catalogues/${ISA}/controls`;
const reviewsOf = (ref: string) => `${CONTROLS}/${ref}/reviews`;

const DAY = 24 * 3600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

const app_: Asset = { kind: "repo", ref: repoRef("app") };
const api: Asset = { kind: "repo", ref: repoRef("api") };
const UNAPPROVED: RuleId = "guard/unapproved-ai-tool";
const MCP: RuleId = "guard/mcp-server-unpinned";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let repoAssets: RepoAssets;
let controlReviews: ControlReviews;
let app: Hono<AppEnv>;
/** Every read or write the Vouch routes made of a store since the case began. */
let touched: string[];

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
  repoAssets = createRepoAssets({ withTeam });
  controlReviews = createControlReviews({ withTeam });
  const teamCatalogues = createTeamCatalogues({ withTeam });
  const teamAssets = createTeamAssets({ repoAssets, products: createProducts({ withTeam }) });
  // The real stores, each call noted first, so a case can see that a refusal touched none.
  const noted =
    <A extends unknown[], R>(name: string, use: (...args: A) => R) =>
    (...args: A): R => {
      touched.push(name);
      return use(...args);
    };
  ({ app } = testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      vouchRoutes({
        teamCatalogues: {
          list: noted("teamCatalogues.list", teamCatalogues.list),
          set: noted("teamCatalogues.set", teamCatalogues.set),
        },
        catalogues: [VDA_ISA_2027_1],
        findings: {
          listByRules: noted("listByRules", findings.listByRules),
          coverageSince: noted("coverageSince", findings.coverageSince),
          lastSpotRunAt: noted("lastSpotRunAt", findings.lastSpotRunAt),
        },
        teamAssets: { held: noted("teamAssets.held", teamAssets.held) } satisfies TeamAssets,
        controlReviews: {
          add: noted("controlReviews.add", controlReviews.add),
          list: noted("controlReviews.list", controlReviews.list),
        },
      }),
    ],
  }));
});

beforeEach(() => {
  touched = [];
});

afterAll(() => pool.end());

/** A Team with an Admin, a Lead and a Member, and nothing scanned: every Control not evidenced. */
const team = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);

const review = (teamId: string, ref: string, body: unknown, as = LEAD) =>
  call(app, key, "POST", reviewsOf(ref), { as, teamId, body });

const readControls = async (teamId: string) => {
  const res = await call(app, key, "GET", CONTROLS, { as: MEMBER, teamId });
  expect(res.status).toBe(200);
  return ControlsBody.parse(res.body);
};

const readControl = async (teamId: string, ref: string) => {
  const res = await call(app, key, "GET", `${CONTROLS}/${ref}`, { as: MEMBER, teamId });
  expect(res.status).toBe(200);
  return ControlDetail.parse(res.body);
};

const listed = (body: ControlsBody, ref: string) => {
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

/** A Guard Scan `days` ago of Repos app and api for 1.3.3's Rules, finding `observations`. */
const scan1_3_3 = (teamId: string, days: number, observations: Observation[] = []) =>
  findings.reconcile({
    id: `scan-${randomUUID()}`,
    team: teamId,
    module: "guard",
    started_at: daysAgo(days).toISOString(),
    assets: [app_, api],
    rules: [UNAPPROVED, MCP],
    observations,
  });

/** A Team holding Repos app and api, both scanned for 1.3.3's Rules two days ago with nothing found: 1.3.3 evidenced. */
async function evidencedTeam() {
  const teamId = await team();
  await linkRepos(repoAssets, teamId, [app_.ref, api.ref]);
  await scan1_3_3(teamId, 2);
  return teamId;
}

describe("POST .../controls/:ref/reviews: a Lead confirms or overrides a Verdict (story 4)", () => {
  it("takes a Lead's confirm of 1.3.3: 1.3.3 reads reviewed at its worked-out Verdict, the others not reviewed", async () => {
    const teamId = await evidencedTeam();

    const res = await review(teamId, "1.3.3", { outcome: "confirm" });

    expect(res.status).toBe(201);
    const answer = ControlDetail.parse(res.body);
    expect(answer).toMatchObject({
      ref: "1.3.3",
      verdict: "evidenced",
      review_state: "reviewed",
      reviewed_verdict: "evidenced",
    });
    expect(answer).toEqual(await readControl(teamId, "1.3.3"));
    const body = await readControls(teamId);
    expect(
      body.controls.map(({ ref, verdict, review_state, reviewed_verdict }) => ({
        ref,
        verdict,
        review_state,
        reviewed_verdict,
      })),
    ).toEqual([
      {
        ref: "1.3.3",
        verdict: "evidenced",
        review_state: "reviewed",
        reviewed_verdict: "evidenced",
      },
      {
        ref: "1.3.4",
        verdict: "not_evidenced",
        review_state: "not_reviewed",
        reviewed_verdict: null,
      },
      {
        ref: "4.1.3",
        verdict: "not_evidenced",
        review_state: "not_reviewed",
        reviewed_verdict: null,
      },
      {
        ref: "5.2.4",
        verdict: "not_evidenced",
        review_state: "not_reviewed",
        reviewed_verdict: null,
      },
    ]);
    // The list holds no review history; the one-Control read does.
    expect(listed(body, "1.3.3")).not.toHaveProperty("reviews");
  });

  it("takes a Lead's override of 5.2.4 to not applicable: reviewed as not_applicable, its worked-out Verdict unchanged", async () => {
    const teamId = await team();

    const res = await review(teamId, "5.2.4", {
      outcome: "override",
      verdict: "not_applicable",
      reason: "This Team runs no AI agents in production",
    });

    expect(res.status).toBe(201);
    const expected = {
      verdict: "not_evidenced",
      review_state: "reviewed",
      reviewed_verdict: "not_applicable",
    };
    expect(ControlDetail.parse(res.body)).toMatchObject(expected);
    expect(listed(await readControls(teamId), "5.2.4")).toMatchObject(expected);
    expect(await readControl(teamId, "5.2.4")).toMatchObject(expected);
  });

  it("takes an Admin's review", async () => {
    const teamId = await team();

    const res = await review(teamId, "4.1.3", { outcome: "confirm" }, ADMIN);

    expect(res.status).toBe(201);
    expect(ControlDetail.parse(res.body)).toMatchObject({
      review_state: "reviewed",
      reviews: [{ reviewed_by: ADMIN }],
    });
  });
});

describe("who may review (story 5)", () => {
  it.each([
    ["confirm", { outcome: "confirm" }],
    ["override", { outcome: "override", verdict: "not_applicable", reason: "Not ours" }],
  ])("answers a Member's %s 403, and the Team holds no review", async (_name, body) => {
    const teamId = await team();

    const res = await review(teamId, "1.3.3", body, MEMBER);

    expect(res.status).toBe(403);
    expect(await controlReviews.list(teamId, ISA)).toEqual([]);
  });

  it("answers no session the app's 401", async () => {
    const res = await app.request(reviewsOf("1.3.3"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "confirm" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("a refused review stores nothing", () => {
  it.each<[string, unknown, RegExp]>([
    ["a body that isn't JSON", "{", /^body: /],
    ["an override with no reason", { outcome: "override", verdict: "evidenced" }, /^reason: /],
    [
      "an override with a blank reason",
      { outcome: "override", verdict: "evidenced", reason: "  \n" },
      /^reason: /,
    ],
    [
      "a reason over 2,000 characters",
      { outcome: "override", verdict: "evidenced", reason: "x".repeat(2001) },
      /^reason: /,
    ],
    [
      "a reason holding a NUL",
      { outcome: "confirm", reason: "Checked\0 by hand" },
      /^reason: .*NUL/,
    ],
    [
      "a Verdict that isn't a reviewed Verdict",
      { outcome: "override", verdict: "maybe", reason: "Unsure" },
      /^verdict: /,
    ],
    ["a reviewer in the body", { outcome: "confirm", reviewed_by: ADMIN }, /reviewed_by/],
    [
      "a worked-out Verdict in the body",
      { outcome: "confirm", worked_out_verdict: "evidenced" },
      /worked_out_verdict/,
    ],
    ["a Team in the body", { outcome: "confirm", team: "org_other" }, /team/],
  ])("answers %s 400 with the refused field", async (_name, body, message) => {
    const teamId = await team();

    const res = await review(teamId, "1.3.3", body);

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(message);
    expect(await controlReviews.list(teamId, ISA)).toEqual([]);
  });

  it("answers an override to the worked-out Verdict 400: confirm it instead", async () => {
    const teamId = await team();

    const res = await review(teamId, "1.3.3", {
      outcome: "override",
      verdict: "not_evidenced",
      reason: "Still nothing scanned",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "An override must change the Verdict; confirm it instead",
    });
    expect(await controlReviews.list(teamId, ISA)).toEqual([]);
  });

  it("answers a Catalogue Warden doesn't have 404 `No such Catalogue`, touching no store", async () => {
    const teamId = await team();

    const res = await call(
      app,
      key,
      "POST",
      "/api/vouch/catalogues/iso-27001/controls/1.3.3/reviews",
      {
        as: LEAD,
        teamId,
        body: { outcome: "confirm" },
      },
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Catalogue" });
    expect(touched).toEqual([]);
  });

  it.each([
    ["a Control the Catalogue doesn't judge", "1.6.1"],
    ["a ref that isn't dotted numbers", "abc"],
    ["a ref short of a Control", "1.3"],
  ])("answers %s 404 `No such Control`, touching no store", async (_name, ref) => {
    const teamId = await team();

    const res = await review(teamId, ref, { outcome: "confirm" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Control" });
    expect(touched).toEqual([]);
  });
});

describe("a Control's reviews (story 6)", () => {
  it("lists each review newest first, with what it did, the Verdicts, the reason, when and the session's reviewer", async () => {
    const teamId = await team();
    const before = Date.now();
    await review(teamId, "4.1.3", { outcome: "confirm", reason: "Nothing to scan yet" }, LEAD);
    await review(
      teamId,
      "4.1.3",
      { outcome: "override", verdict: "partly_evidenced", reason: "Secrets checked by hand" },
      ADMIN,
    );

    const { reviews, review_state, reviewed_verdict } = await readControl(teamId, "4.1.3");

    // `toMatchObject` on an array checks its length and each review's fields; `ControlDetail` has parsed each `id`,
    // and `reviewed_at` is checked below.
    expect(reviews).toMatchObject([
      {
        worked_out_verdict: "not_evidenced",
        outcome: "overridden",
        verdict: "partly_evidenced",
        reason: "Secrets checked by hand",
        reviewed_by: ADMIN,
      },
      {
        worked_out_verdict: "not_evidenced",
        outcome: "confirmed",
        verdict: "not_evidenced",
        reason: "Nothing to scan yet",
        reviewed_by: LEAD,
      },
    ]);
    for (const { reviewed_at } of reviews) {
      expect(Date.parse(reviewed_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(reviewed_at)).toBeLessThanOrEqual(Date.now());
    }
    expect({ review_state, reviewed_verdict }).toEqual({
      review_state: "reviewed",
      reviewed_verdict: "partly_evidenced",
    });
  });

  it("answers a confirm without a reason with a null reason", async () => {
    const teamId = await team();

    const res = await review(teamId, "1.3.4", { outcome: "confirm" });

    expect(ControlDetail.parse(res.body).reviews).toMatchObject([
      { outcome: "confirmed", reason: null, reviewed_by: LEAD },
    ]);
  });
});

describe("changed since review (story 7)", () => {
  it("reads 1.3.3 changed since review once an Open Finding under its Rule is reconciled, and reviewed again after a new review", async () => {
    const teamId = await evidencedTeam();
    await review(teamId, "1.3.3", { outcome: "confirm" });

    await scan1_3_3(teamId, 1, [observation(app_, UNAPPROVED)]);
    const changed = listed(await readControls(teamId), "1.3.3");

    expect(changed).toMatchObject({
      verdict: "partly_evidenced",
      review_state: "changed_since_review",
      reviewed_verdict: null,
    });
    expect(await readControl(teamId, "1.3.3")).toMatchObject({
      verdict: "partly_evidenced",
      review_state: "changed_since_review",
      reviewed_verdict: null,
    });

    const res = await review(teamId, "1.3.3", { outcome: "confirm" });

    expect(res.status).toBe(201);
    expect(listed(await readControls(teamId), "1.3.3")).toMatchObject({
      verdict: "partly_evidenced",
      review_state: "reviewed",
      reviewed_verdict: "partly_evidenced",
    });
  });
});

describe("Teams apart (story 10)", () => {
  it("leaves Team A's 1.3.3 not reviewed when Team B's Lead reviews it, and Team B reads none of Team A's reviews", async () => {
    const teamA = await team();
    const teamB = await team();
    const reasonA = `Team A's own reason ${randomUUID()}`;
    await review(teamA, "4.1.3", {
      outcome: "override",
      verdict: "not_applicable",
      reason: reasonA,
    });

    const res = await review(teamB, "1.3.3", { outcome: "confirm" });

    expect(res.status).toBe(201);
    expect(await readControl(teamA, "1.3.3")).toMatchObject({
      review_state: "not_reviewed",
      reviewed_verdict: null,
      reviews: [],
    });
    // Team A's 4.1.3 is reviewed; Team B's isn't, and neither of Team B's reads holds Team A's review.
    expect((await readControl(teamA, "4.1.3")).review_state).toBe("reviewed");
    const oneB = await call(app, key, "GET", `${CONTROLS}/4.1.3`, { as: MEMBER, teamId: teamB });
    expect(ControlDetail.parse(oneB.body)).toMatchObject({
      review_state: "not_reviewed",
      reviews: [],
    });
    expect(oneB.text).not.toContain(reasonA);
    const listB = await call(app, key, "GET", CONTROLS, { as: MEMBER, teamId: teamB });
    expect(listed(ControlsBody.parse(listB.body), "4.1.3").review_state).toBe("not_reviewed");
    expect(listB.text).not.toContain(reasonA);
  });
});
