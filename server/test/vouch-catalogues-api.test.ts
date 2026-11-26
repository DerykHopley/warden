// Stories 1 and 10 at the API (spec #341, slice 1b): an Admin turns the VDA ISA 2027.1 Catalogue on or off for the
// Team (`PUT /api/vouch/catalogues/:id`), and every person in the Team reads it with its four judged Controls
// (`GET /api/vouch/catalogues`). Through the real app with the Vouch routes mounted as the start-up file mounts them,
// on the suite's shared database, each case with Teams of its own.
import { CataloguesBody, TeamCatalogue } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings } from "../src/findings/index.ts";
import { createRepoAssets } from "../src/modules/guard/repo-assets.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { VDA_ISA_2027_1 } from "../src/modules/vouch/catalogue.ts";
import { vouchRoutes } from "../src/modules/vouch/routes.ts";
import { createTeamAssets } from "../src/modules/vouch/team-assets.ts";
import { createTeamCatalogues } from "../src/modules/vouch/team-catalogues.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, call, newTeam, testApp, testKey } from "./helpers.ts";

const LEAD = "user_lead";
const MEMBER = "user_member";
const ISA = "vda-isa-2027.1";
const PATH = "/api/vouch/catalogues";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      vouchRoutes({
        teamCatalogues: createTeamCatalogues({ withTeam }),
        catalogues: [VDA_ISA_2027_1],
        // Read only by the Controls routes, which `vouch-controls-api.test.ts` covers.
        findings: createFindings({ withTeam, moveRules: {} }),
        teamAssets: createTeamAssets({
          repoAssets: createRepoAssets({ withTeam }),
          products: createProducts({ withTeam }),
        }),
      }),
    ],
  }));
});

afterAll(() => pool.end());

/** A Team with an Admin, a Lead and a Member. */
const team = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);

const read = async (teamId: string, as = MEMBER) => {
  const res = await call(app, key, "GET", PATH, { as, teamId });
  expect(res.status).toBe(200);
  return CataloguesBody.parse(res.body);
};

/** The Team's ISA Catalogue, as `as` reads it. */
const isaOf = async (teamId: string, as = MEMBER) => {
  const isa = (await read(teamId, as)).catalogues.find(({ id }) => id === ISA);
  if (isa === undefined) throw new Error(`GET ${PATH} has no ${ISA}`);
  return isa;
};

const turn = (teamId: string, body: unknown, { as = ADMIN, id = ISA } = {}) =>
  call(app, key, "PUT", `${PATH}/${id}`, { as, teamId, body });

/** The Team's `team_catalogues` rows, read as that Team. */
const rows = (teamId: string) =>
  withTeam(teamId, (tx) => tx.selectFrom("team_catalogues").selectAll().execute());

describe("PUT /api/vouch/catalogues/:id: an Admin turns the Catalogue on or off (story 1)", () => {
  it("shows it on with the Admin's user id and the time, then off once the Admin turns it off", async () => {
    const teamId = await team();

    const before = Date.now();
    const on = await turn(teamId, { on: true });
    const after = Date.now();

    expect(on.status).toBe(200);
    expect(TeamCatalogue.parse(on.body)).toEqual(await isaOf(teamId));
    const shown = await isaOf(teamId);
    expect(shown).toMatchObject({ on: true, set_by: ADMIN });
    const setAt = Date.parse(shown.set_at ?? "");
    expect(setAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(setAt).toBeLessThanOrEqual(after + 1_000);

    const off = await turn(teamId, { on: false });

    expect(off.status).toBe(200);
    expect(TeamCatalogue.parse(off.body)).toMatchObject({ on: false, set_by: ADMIN });
    expect(await isaOf(teamId)).toMatchObject({ on: false, set_by: ADMIN });
    expect(await rows(teamId)).toHaveLength(1);
  });

  it("answers 200 to turning on a Catalogue already on, replacing who set it and when", async () => {
    const teamId = await newTeam(withTeam, [
      [ADMIN, "admin"],
      ["user_admin_2", "admin"],
    ]);
    await turn(teamId, { on: true });
    const first = await isaOf(teamId);

    const again = await turn(teamId, { on: true }, { as: "user_admin_2" });

    expect(again.status).toBe(200);
    const shown = await isaOf(teamId);
    expect(shown).toMatchObject({ on: true, set_by: "user_admin_2" });
    expect(Date.parse(shown.set_at ?? "")).toBeGreaterThanOrEqual(Date.parse(first.set_at ?? ""));
    expect(await rows(teamId)).toHaveLength(1);
  });

  it.each([
    ["a Lead", LEAD],
    ["a Member", MEMBER],
  ])(
    "answers %s 403 `Your Role can't do this`, and the Catalogue stays as it was",
    async (_name, as) => {
      const teamId = await team();
      await turn(teamId, { on: true });
      const before = await isaOf(teamId);

      const res = await turn(teamId, { on: false }, { as });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Your Role can't do this" });
      expect(await isaOf(teamId)).toEqual(before);
    },
  );

  it.each<[string, unknown]>([
    ["no body", undefined],
    ["a body that isn't JSON", "on=true"],
    ["`on` that isn't a boolean", { on: "yes" }],
    ["an extra field", { on: true, catalogue: ISA }],
    ["no `on`", {}],
  ])("answers 400 for %s, and stores no row", async (_name, body) => {
    const teamId = await team();

    const res = await turn(teamId, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(await rows(teamId)).toEqual([]);
  });

  it.each([
    ["a Catalogue Warden doesn't have", "iso-27001"],
    ["an id holding a NUL", "vda-isa-2027.1%00"],
  ])("answers 404 `No such Catalogue` for %s, and stores no row", async (_name, id) => {
    const teamId = await team();

    const res = await turn(teamId, { on: true }, { id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Catalogue" });
    expect(await rows(teamId)).toEqual([]);
  });
});

describe("GET /api/vouch/catalogues: every person reads the Team's Catalogues", () => {
  it("shows a Member of a Team that never set it the Catalogue off, its four judged Controls, credit and licence", async () => {
    const teamId = await team();

    const body = await read(teamId, MEMBER);

    expect(body.catalogues.map(({ id }) => id)).toEqual([ISA]);
    expect(body.catalogues[0]).toEqual({
      id: VDA_ISA_2027_1.id,
      name: VDA_ISA_2027_1.name,
      date: VDA_ISA_2027_1.date,
      credit: VDA_ISA_2027_1.credit,
      licence: VDA_ISA_2027_1.licence.name,
      licence_url: VDA_ISA_2027_1.licence.url,
      on: false,
      set_by: null,
      set_at: null,
      controls: VDA_ISA_2027_1.judgedControls.map(({ id, question, iso_27001 }) => ({
        ref: id,
        question,
        iso_27001,
      })),
    });
  });
});

describe("Teams apart (story 10)", () => {
  it("shows Team B none of Team A's choice, and Team B's Admin turning it off leaves Team A's on", async () => {
    const teamA = await team();
    const teamB = await team();

    await turn(teamA, { on: true });

    expect(await isaOf(teamB)).toMatchObject({ on: false, set_by: null, set_at: null });

    expect((await turn(teamB, { on: false })).status).toBe(200);

    expect(await isaOf(teamA)).toMatchObject({ on: true, set_by: ADMIN });
    expect(await isaOf(teamB)).toMatchObject({ on: false });
  });
});
