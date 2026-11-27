// The demo seed (`pnpm --filter @warden/server seed <team>`): the demo Findings from `@warden/contracts/demo` in one
// Team, through the Findings module's reconcile, report and named decisions, then the demo Product and its Patch
// Scan. Each case uses a Team of its own in the suite's shared database, which holds the CVE snapshot; the cases with
// no snapshot use a database of their own. Some run the script as its own process.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, type Finding, type Product } from "@warden/contracts";
import {
  DEMO_OBSERVATIONS,
  DEMO_OUTCOME,
  DEMO_PRODUCT,
  demoRuns,
  type DemoKey,
} from "@warden/contracts/demo";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runDailyExpiry } from "../src/daily-expiry.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import {
  createRepoAssets,
  InstallationLinkedElsewhere,
  type RepoAssets,
} from "../src/modules/guard/repo-assets.ts";
import { createProducts, type Products } from "../src/modules/patch/products.ts";
import { createPatchScan } from "../src/modules/patch/scan.ts";
import { createAuditReads } from "../src/modules/vouch/audit.ts";
import { VDA_ISA_2027_1 } from "../src/modules/vouch/catalogue.ts";
import { judgeCatalogue } from "../src/modules/vouch/controls.ts";
import { createVouchDeps, type VouchDeps } from "../src/modules/vouch/deps.ts";
import {
  DEMO_REPO,
  demoFindingsIn,
  demoInstallationId,
  onProduct,
  seedDemo,
  seedRefusal,
} from "../src/seed.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { runCommand } from "./child-process.ts";
import { ownDatabase, runInServer } from "./databases.ts";
import { patchRefresh, seedTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let products: Products;
let repoAssets: RepoAssets;
let vouch: VouchDeps;

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
  products = createProducts({ withTeam });
  repoAssets = createRepoAssets({ withTeam });
  // As the start-up file wires Vouch.
  vouch = createVouchDeps({ withTeam, findings, repoAssets, products });
});

afterAll(() => pool.end());

const newTeam = () => `org_${randomUUID()}`;
const NOW = new Date("2026-11-24T12:00:00Z");
const DEMO_COUNT = Object.keys(DEMO_OBSERVATIONS).length;

/** The made-up Product Asset the demo's Patch Findings are on: no Product row holds it. */
const SHOP = DEMO_OBSERVATIONS.lodash.asset;
const SHOP_COUNT = Object.values(DEMO_OBSERVATIONS).filter(
  (o) => o.asset.kind === SHOP.kind && o.asset.ref === SHOP.ref,
).length;

const ISA = VDA_ISA_2027_1.id;
/** The Controls the seed confirms: every judged one but 1.3.3, which waits for a Lead in the demo. */
const CONFIRMED = ["1.3.4", "4.1.3", "5.2.4"] as const;

/** Every review the Team made of each of ISA2027's judged Controls, newest first, by Control. */
async function reviewsOf(team: string) {
  const reviews: Record<string, Awaited<ReturnType<VouchDeps["controlReviews"]["history"]>>> = {};
  for (const { id } of VDA_ISA_2027_1.judgedControls) {
    reviews[id] = await vouch.controlReviews.history(team, ISA, id);
  }
  return reviews;
}

/**
 * Everything the seed writes in `team`: its Products, Findings and Scans, and its Repo Assets, Catalogue choices and
 * reviews, to compare before and after.
 */
async function stateOf(team: string) {
  return {
    products: await products.list(team),
    findings: await findings.list(team),
    scans: await withTeam(team, (tx) => tx.selectFrom("scans").selectAll().orderBy("id").execute()),
    repoAssets: await repoAssets.list(team),
    catalogues: await vouch.teamCatalogues.list(team),
    reviews: await reviewsOf(team),
  };
}

/** No Repo Asset, no Catalogue choice and no review: the Vouch state left out. */
async function expectNoVouchState(team: string) {
  expect(await repoAssets.list(team)).toEqual([]);
  expect(await vouch.teamCatalogues.list(team)).toEqual([]);
  expect(Object.values(await reviewsOf(team)).flat()).toEqual([]);
}

/**
 * The Vouch state the seed leaves: the demo Repo held, ISA2027 on, and 1.3.4, 4.1.3 and 5.2.4 each with one review, a
 * confirm by `by` with a `Demo seed:` reason; 1.3.3 with none.
 */
async function expectVouchState(team: string, by: string) {
  expect((await repoAssets.list(team)).map(({ ref }) => ref)).toEqual([DEMO_REPO]);
  expect(await vouch.teamCatalogues.list(team)).toEqual([
    { catalogue: ISA, on: true, setBy: by, setAt: expect.any(Date) },
  ]);
  const reviews = await reviewsOf(team);
  expect(reviews["1.3.3"]).toEqual([]);
  for (const ref of CONFIRMED) {
    const [review, ...older] = reviews[ref]!;
    expect(older).toEqual([]);
    expect(review).toMatchObject({
      controlRef: ref,
      outcome: "confirmed",
      reviewedBy: by,
      reason: expect.stringMatching(/^Demo seed: /),
    });
    expect(review?.verdict).toBe(review?.workedOutVerdict);
  }
}

/** Seeds `team` as the seed did before its Vouch step: the demo Findings, then the demo Product and its Patch Scan. */
async function seedAsBeforeVouch(team: string) {
  expect((await seedDemo({ pool, team, now: NOW, withProduct: false })).kind).toBe("seeded");
  const { id } = await products.create(team, DEMO_PRODUCT);
  await createPatchScan({ findings, logger: createLogger(() => {}) }).scanProduct(team, { id });
  await expectNoVouchState(team);
}

/** The Team's demo Finding `name`, found by today's demo data, as the seed finds it. */
async function demoFinding(team: string, name: DemoKey): Promise<Finding> {
  const finding = demoFindingsIn(await findings.list(team))[name];
  if (finding === undefined) throw new Error(`no ${name} demo Finding`);
  return finding;
}

/** The demo Rule ids an older seed wrote: the secret's before 7cfe35b, the broad Bash allow's before #226. */
const OLD_RULE_ID = {
  secret: "guard/committed-secret",
  push: "guard/agent-can-push-main",
} as const satisfies Partial<Record<DemoKey, string>>;

/** Gives the Team's demo Finding `name` (the secret, unless named) the Rule id and fingerprint an older seed wrote. */
async function asSeededBeforeRename(team: string, name: keyof typeof OLD_RULE_ID = "secret") {
  const { id, location } = await demoFinding(team, name);
  const rule = OLD_RULE_ID[name];
  await withTeam(team, (tx) =>
    tx
      .updateTable("findings")
      .set({ rule_id: rule, fingerprint: fingerprint(rule, location) })
      .where("id", "=", id)
      .execute(),
  );
  return id;
}

/** Each of `list`, with its history: what a rerun must leave as it was. */
const withHistories = (team: string, list: readonly Finding[]) =>
  Promise.all(list.map(async (f) => ({ finding: f, history: await findings.history(team, f.id) })));

const lead = { kind: "person", id: "user_admin" } as const;

/** Expects the Team's Products to be the demo Product alone, and returns it. */
async function expectOneDemoProduct(team: string): Promise<Product> {
  const [product, ...more] = await products.list(team);
  expect(more).toEqual([]);
  expect(product).toEqual({ id: expect.any(String), ...DEMO_PRODUCT });
  return product!;
}

/** The demo Findings in `team`, as the seed counts them: every Finding but the ones on its demo Product's Asset. */
async function demoFindingsOf(team: string) {
  const { id } = await expectOneDemoProduct(team);
  return (await findings.list(team)).filter((f) => !onProduct(f, id));
}

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

  const noPgpass = () => false;

  it("takes any value on a local database: 127.0.0.1, localhost or ::1, with no password", () => {
    for (const PGHOST of ["127.0.0.1", "localhost", "::1", undefined]) {
      expect(
        seedRefusal(
          { PGHOST, PGDATABASE: "warden", WARDEN_SEED_DEMO: "1", HOME: "/home/dev" },
          noPgpass,
        ),
      ).toBeUndefined();
    }
  });

  /**
   * Expects the database `where` names (on 127.0.0.1 unless it sets PGHOST) to count as hosted: WARDEN_SEED_DEMO must
   * name it, it seeds once named, warden is never seeded, and both refusals name `signal`.
   */
  function expectHosted(
    where: Record<string, string>,
    fileExists: (path: string) => boolean,
    signal: RegExp,
  ) {
    const env = { PGHOST: "127.0.0.1", ...where };
    const unnamed = seedRefusal(
      { ...env, PGDATABASE: "warden_preview", WARDEN_SEED_DEMO: "1" },
      fileExists,
    );
    expect(unnamed).toMatch(/WARDEN_SEED_DEMO must name the database, warden_preview/);
    expect(unnamed).toMatch(signal);
    expect(
      seedRefusal(
        { ...env, PGDATABASE: "warden_preview", WARDEN_SEED_DEMO: "warden_preview" },
        fileExists,
      ),
    ).toBeUndefined();
    const live = seedRefusal(
      { ...env, PGDATABASE: "warden", WARDEN_SEED_DEMO: "warden" },
      fileExists,
    );
    expect(live).toMatch(/live database, warden/);
    expect(live).toMatch(signal);
  }

  it("elsewhere, or with a password (the Cloud SQL Auth Proxy listens locally), needs the database's name and never seeds warden", () => {
    expectHosted(
      { PGHOST: "/cloudsql/project:europe-west1:warden-db" },
      noPgpass,
      /PGHOST is \/cloudsql\/project:europe-west1:warden-db/,
    );
    expectHosted({ PGHOST: "10.0.0.5" }, noPgpass, /PGHOST is 10\.0\.0\.5/);
    expectHosted({ PGPASSWORD: "x" }, noPgpass, /PGPASSWORD is set/);
  });

  // The Cloud SQL Auth Proxy listens on 127.0.0.1, and pg finds a password in PGPASSFILE's file, PGSERVICE's entry or
  // ~/.pgpass as well as PGPASSWORD: any of them makes the database count as hosted (#396).
  describe("on 127.0.0.1 with a password from a file or a service", () => {
    /** A file check that gives the same answer, `exists`, for every path it's asked about, and records each one in
     * `asked`. */
    const recordingPgpass =
      (exists: boolean, asked: string[]) =>
      (path: string): boolean => {
        asked.push(path);
        return exists;
      };
    /** A file check that can't tell whether any path exists. */
    const cantTell = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };

    it("with PGPASSFILE set, needs the database's name and never seeds warden", () => {
      expectHosted({ PGPASSFILE: "/some/file" }, noPgpass, /PGPASSFILE/);
    });

    it("with PGSERVICE set, needs the database's name and never seeds warden", () => {
      expectHosted({ PGSERVICE: "warden-proxy" }, noPgpass, /PGSERVICE/);
    });

    it("with a .pgpass in HOME, needs the database's name and never seeds warden", () => {
      const asked: string[] = [];
      expectHosted({ HOME: "/home/dev" }, recordingPgpass(true, asked), /~\/\.pgpass/);
      expect(new Set(asked)).toEqual(new Set(["/home/dev/.pgpass"]));
    });

    it("counts as hosted when it can't tell whether ~/.pgpass exists", () => {
      const refusal = seedRefusal(
        { PGHOST: "127.0.0.1", HOME: "/home/dev", PGDATABASE: "warden", WARDEN_SEED_DEMO: "1" },
        cantTell,
      );
      expect(refusal).toMatch(/live database, warden/);
      expect(refusal).toMatch(/~\/\.pgpass/);
    });

    it("looks for .pgpass on disk when no fileExists is given", () => {
      const home = mkdtempSync(join(tmpdir(), "warden-seed-home-"));
      try {
        const env = {
          PGHOST: "127.0.0.1",
          HOME: home,
          PGDATABASE: "warden",
          WARDEN_SEED_DEMO: "1",
        };
        expect(seedRefusal(env)).toBeUndefined();
        writeFileSync(join(home, ".pgpass"), "");
        expect(seedRefusal(env)).toMatch(/live database, warden .*~\/\.pgpass exists/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("takes an empty PGPASSFILE or PGSERVICE, or no HOME, as no password", () => {
      for (const where of [{ PGPASSFILE: "" }, { PGSERVICE: "" }, { HOME: "" }, {}]) {
        const asked: string[] = [];
        expect(
          seedRefusal(
            { PGHOST: "127.0.0.1", ...where, PGDATABASE: "warden", WARDEN_SEED_DEMO: "1" },
            recordingPgpass(false, asked),
          ),
        ).toBeUndefined();
        // None of these sets HOME, so pg would read .pgpass in the working folder: that's where it looks (#476).
        expect(asked).toEqual([".pgpass"]);
      }
    });

    // With HOME unset or empty, pg reads .pgpass in the folder the process runs from (pgpass 1.0.5:
    // `path.join(env.HOME || './', '.pgpass')`), so a .pgpass there counts as a password too (#476).
    describe("with no HOME", () => {
      for (const [name, noHome] of [
        ["HOME unset", {}],
        ["HOME empty", { HOME: "" }],
      ] as const) {
        it(`${name}: a .pgpass in the working folder needs the database's name and never seeds warden`, () => {
          const asked: string[] = [];
          expectHosted(noHome, recordingPgpass(true, asked), /\.\/\.pgpass exists/);
          expect(new Set(asked)).toEqual(new Set([".pgpass"]));
        });

        it(`${name}: counts as hosted when it can't tell whether ./.pgpass exists`, () => {
          const refusal = seedRefusal(
            { PGHOST: "127.0.0.1", ...noHome, PGDATABASE: "warden", WARDEN_SEED_DEMO: "1" },
            cantTell,
          );
          expect(refusal).toMatch(/live database, warden/);
          expect(refusal).toMatch(/\.\/\.pgpass couldn't be checked/);
        });
      }
    });
  });
});

describe("seedDemo", () => {
  it("fills a Team with the demo Findings across modules, Asset kinds, Severities and every Status", async () => {
    const team = await teamWith([
      ["user_admin", "admin"],
      ["user_member", "member"],
    ]);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "seeded", findings: (await findings.list(team)).length });
    const list = await demoFindingsOf(team);
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
    // The committed secret names the Default Pack's Rule, which both seeded Guard Scans cover, so it stays Open.
    expect(open.filter((f) => f.rule_id === "guard/secret-in-repo")).toHaveLength(1);
    const atSecret = list.filter(
      (f) => f.location.kind === "file" && f.location.path === "config/payments.ts",
    );
    expect(atSecret.map((f) => f.rule_id)).toEqual(["guard/secret-in-repo"]);
  });

  it("then creates the demo Product and runs its Patch Scan, opening CVE Findings on it from the snapshot", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("seeded");

    const { id } = await expectOneDemoProduct(team);
    expect(await demoFindingsOf(team)).toHaveLength(DEMO_COUNT);
    const cves = (await findings.list(team)).filter((f) => onProduct(f, id));
    const open = cves.filter(
      (f) => f.status === "open" && f.rule_id === "patch/known-vulnerability",
    );
    expect(open.length).toBeGreaterThan(0);
    for (const finding of open) {
      expect(finding.location).toEqual({
        kind: "dependency",
        package: expect.stringMatching(/^pkg:pypi\/langchain/),
        version: "0.0.200",
        vulnerability: expect.stringMatching(/^CVE-/),
      });
    }
  });

  it("decides the Accepted and False positive ones as the Team's oldest Admin or Lead, for 90 days", async () => {
    const team = await teamWith([
      ["user_member", "member"],
      ["user_lead", "lead"],
    ]);

    await seedDemo({ pool, team, now: NOW });

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

  it("run again, says the Team is already seeded and changes no Product, Finding, Scan, Repo Asset, Catalogue choice or review", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const before = await stateOf(team);
    expect(before.products).toHaveLength(1);

    expect(await seedDemo({ pool, team, now: new Date() })).toEqual({
      kind: "already_seeded",
      findings: before.findings.length,
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("two runs at once: one seeds, the other finds it seeded, and the Team has one demo Product", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const results = await Promise.all([
      seedDemo({ pool, team, now: NOW }),
      seedDemo({ pool, team, now: new Date(NOW.getTime() + 1000) }),
    ]);

    expect(results.map((r) => r.kind).sort()).toEqual(["already_seeded", "seeded"]);
    expect(await demoFindingsOf(team)).toHaveLength(DEMO_COUNT);
  });

  it("refuses a Team with a Product of its own, not yet seeded, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    // Its name is the demo Product's: a Lead's Product is never taken for it.
    await products.create(team, { ...DEMO_PRODUCT, repo_urls: [] });
    const before = await stateOf(team);

    expect(await seedDemo({ pool, team, now: NOW })).toEqual({
      kind: "other_products",
      products: 1,
    });
    expect(await stateOf(team)).toEqual(before);
    await expectNoVouchState(team);
  });

  it("on a rerun, finishes a Team seeded without the demo Product: creates it, runs its Scan and adds ISA2027", async () => {
    // As after --no-product, a seed from before the demo Product, or a Product step cut short after the Findings.
    const team = await teamWith([["user_admin", "admin"]]);
    expect((await seedDemo({ pool, team, now: NOW, withProduct: false })).kind).toBe("seeded");
    // --no-product has no Vouch step: the browser tests' Acme and Bluebird stay without a Catalogue or a Repo Asset.
    await expectNoVouchState(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "seeded", findings: (await findings.list(team)).length });
    const { id } = await expectOneDemoProduct(team);
    expect(await demoFindingsOf(team)).toHaveLength(DEMO_COUNT);
    const cves = (await findings.list(team)).filter((f) => onProduct(f, id));
    expect(cves.filter((f) => f.status === "open").length).toBeGreaterThan(0);
    await expectVouchState(team, "user_admin");
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("already_seeded");
  });

  it("on a rerun, finds the Team seeded when a Lead has decided every CVE Finding on the demo Product", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const { id } = await expectOneDemoProduct(team);
    const cves = (await findings.list(team)).filter((f) => onProduct(f, id));
    for (const [i, finding] of cves.entries()) {
      if (i % 2 === 0) {
        await findings.accept(team, finding.id, {
          actor: lead,
          reason: "Not reachable here",
          until: "2027-01-01T00:00:00Z",
        });
      } else {
        await findings.markFalsePositive(team, finding.id, { actor: lead, reason: "Not ours" });
      }
    }
    const before = await stateOf(team);

    expect(await seedDemo({ pool, team, now: NOW })).toEqual({
      kind: "already_seeded",
      findings: before.findings.length,
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("on a rerun, a deleted demo Product's leftover CVE Findings don't match, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const { id } = await expectOneDemoProduct(team);
    const left = (await findings.list(team)).filter((f) => onProduct(f, id)).length;
    await products.remove(team, id);
    const before = await stateOf(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({
      kind: "mismatch",
      problems: [`${left} Finding(s) the seed didn't write`],
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("on a rerun, a demo Product whose LangChain version changed doesn't match, naming the demo Product", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const [langchain] = DEMO_PRODUCT.dependencies;
    await products.update(team, (await expectOneDemoProduct(team)).id, {
      ...DEMO_PRODUCT,
      dependencies: [{ ...langchain!, version: "0.1.0" }],
    });
    const before = await stateOf(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result.kind).toBe("mismatch");
    expect(result.kind === "mismatch" && result.problems).toContainEqual(
      expect.stringMatching(/^demo Product: /),
    );
    expect(await stateOf(team)).toEqual(before);
  });

  // The name index (`lower(btrim(name))`) counts these as the demo Product's name, so the seed must too.
  it.each(["shop web", "  Shop web  "])(
    "on a rerun, a Lead's Product named %j after a seed without the demo Product doesn't match, writing nothing",
    async (name) => {
      const team = await teamWith([["user_admin", "admin"]]);
      await seedDemo({ pool, team, now: NOW, withProduct: false });
      await products.create(team, { name, repo_urls: [], dependencies: [] });
      const before = await stateOf(team);

      const result = await seedDemo({ pool, team, now: NOW });

      expect(result.kind).toBe("mismatch");
      expect(result.kind === "mismatch" && result.problems).toContainEqual(
        expect.stringMatching(/^demo Product: /),
      );
      expect(await stateOf(team)).toEqual(before);
    },
  );

  it("after the daily Job, the made-up Patch Findings keep their Status and a second seed finds the Team seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const shop = async () =>
      (await findings.list(team))
        .filter((f) => onProduct(f, SHOP.ref))
        .map(({ id, status }) => ({ id, status }));
    const before = await shop();
    expect(before).toHaveLength(SHOP_COUNT);

    // The daily Job's entry point for this one Team: warden_app lists only the Team row-level security shows it, and
    // Patch's step is wired as the daily Job wires it.
    const code = await runDailyExpiry({
      withAdmin: (work) => withTeam(team, work),
      findings,
      steps: [patchRefresh(withTeam)],
      logger: createLogger(() => {}),
    });

    expect(code).toBe(0);
    expect(await shop()).toEqual(before);
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("already_seeded");
  });

  it.each(["secret", "push"] as const)(
    "on a rerun, a Team whose %s Finding has the old Rule id is already seeded, and nothing changes",
    async (name) => {
      const team = await teamWith([["user_admin", "admin"]]);
      await seedDemo({ pool, team, now: NOW });
      await asSeededBeforeRename(team, name);
      const before = await stateOf(team);

      expect(await seedDemo({ pool, team, now: NOW })).toEqual({
        kind: "already_seeded",
        findings: before.findings.length,
      });
      expect(await stateOf(team)).toEqual(before);
    },
  );

  it("on a rerun, adds the demo Product to a Team seeded without it whose secret Finding has the old Rule id", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW, withProduct: false });
    const secret = await asSeededBeforeRename(team);
    const [before] = await withHistories(
      team,
      (await findings.list(team)).filter((f) => f.id === secret),
    );

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "seeded", findings: (await findings.list(team)).length });
    const { id } = await expectOneDemoProduct(team);
    const cves = (await findings.list(team)).filter((f) => onProduct(f, id));
    expect(cves.filter((f) => f.status === "open").length).toBeGreaterThan(0);
    const [after] = await withHistories(
      team,
      (await findings.list(team)).filter((f) => f.id === secret),
    );
    expect(after).toEqual(before);
    expect(after?.finding.rule_id).toBe("guard/committed-secret");
  });

  it("on a rerun, adds the demo Product to a Team seeded without it whose Lead has Accepted demo Findings (#209)", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW, withProduct: false });
    for (const name of ["envLocal", "minimist"] as const) {
      await findings.accept(team, (await demoFinding(team, name)).id, {
        actor: lead,
        reason: "Not reachable here",
        until: "2027-01-01T00:00:00Z",
      });
    }
    const before = await withHistories(team, await findings.list(team));

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "seeded", findings: (await findings.list(team)).length });
    const { id } = await expectOneDemoProduct(team);
    expect((await findings.list(team)).some((f) => onProduct(f, id))).toBe(true);
    expect(await withHistories(team, await demoFindingsOf(team))).toEqual(before);
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("already_seeded");
  });

  it("on a rerun, a Team whose Lead has decided demo Findings since the seed is already seeded, and nothing changes", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    await findings.reopen(team, (await demoFinding(team, "axios")).id, {
      actor: lead,
      reason: "Upgrading after all",
    });
    await findings.markFalsePositive(team, (await demoFinding(team, "disk")).id, {
      actor: lead,
      reason: "A test machine",
    });
    await findings.confirmFix(team, (await demoFinding(team, "envSettings")).id, {
      actor: lead,
      reason: "Really fixed",
    });
    const before = await stateOf(team);

    expect(await seedDemo({ pool, team, now: NOW })).toEqual({
      kind: "already_seeded",
      findings: before.findings.length,
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("on a rerun after the daily Job reopened the seed's expired acceptance, the Team is already seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });

    const code = await runDailyExpiry({
      withAdmin: (work) => withTeam(team, work),
      findings,
      steps: [patchRefresh(withTeam)],
      logger: createLogger(() => {}),
      now: new Date(NOW.getTime() + 91 * 24 * 3600_000),
    });

    expect(code).toBe(0);
    expect((await demoFinding(team, "axios")).status).toBe("open");
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("already_seeded");
  });

  it("on a rerun, every demo run applied but not the seed's two decisions doesn't match, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans, spotRun } = demoRuns(team, NOW);
    for (const scan of scans) await findings.reconcile(scan);
    await findings.report(spotRun);
    const before = await stateOf(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({
      kind: "mismatch",
      problems: [
        "push: the seed's decision (false_positive) is missing",
        "axios: the seed's decision (accepted) is missing",
      ],
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("on a rerun, the seed's two decisions made on other demo Findings don't match, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans, spotRun } = demoRuns(team, NOW);
    for (const scan of scans) await findings.reconcile(scan);
    await findings.report(spotRun);
    await findings.markFalsePositive(team, (await demoFinding(team, "disk")).id, {
      actor: lead,
      reason: DEMO_OUTCOME.push.decidedReason!,
    });
    await findings.accept(team, (await demoFinding(team, "minimist")).id, {
      actor: lead,
      reason: DEMO_OUTCOME.axios.decidedReason!,
      until: "2027-01-01T00:00:00Z",
    });
    const before = await stateOf(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({
      kind: "mismatch",
      problems: [
        "push: the seed's decision (false_positive) is missing",
        "axios: the seed's decision (accepted) is missing",
      ],
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("refuses a Team that has Findings of its own, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans } = demoRuns(team, NOW);
    await findings.reconcile({ ...scans[0]!, id: "a-real-scan" });
    const before = await stateOf(team);

    expect(await seedDemo({ pool, team, now: NOW })).toEqual({
      kind: "other_findings",
      findings: before.findings.length,
    });
    expect(await stateOf(team)).toEqual(before);
    await expectNoVouchState(team);
  });

  it("on a rerun, a Finding of the Team's own doesn't match, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const { spotRun } = demoRuns(team, NOW);
    await findings.report({
      ...spotRun,
      id: "a-real-spot-run",
      observations: [
        { ...DEMO_OBSERVATIONS.printed, asset: { kind: "agent_session", ref: "s-2" } },
      ],
    });
    const before = await stateOf(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "mismatch", problems: ["1 Finding(s) the seed didn't write"] });
    expect(await stateOf(team)).toEqual(before);
  });

  it("says a seed that was cut short doesn't match, rather than calling it seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const { scans } = demoRuns(team, NOW);
    await findings.reconcile(scans[0]!);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result.kind).toBe("mismatch");
    expect(result.kind === "mismatch" && result.problems).toContain(
      "only 1 of the 5 demo runs applied",
    );
  });

  it("refuses a Team Warden doesn't have, and one with no Admin or Lead, writing nothing", async () => {
    const missing = newTeam();
    expect(await seedDemo({ pool, team: missing, now: NOW })).toEqual({ kind: "no_team" });
    expect(await findings.list(missing)).toEqual([]);

    const membersOnly = await teamWith([["user_member", "member"]]);
    expect(await seedDemo({ pool, team: membersOnly, now: NOW })).toEqual({
      kind: "no_lead",
    });
    expect(await findings.list(membersOnly)).toEqual([]);
  });
});

describe("the demo seed's ISA2027 state", () => {
  it("answers Not yet as of the seed's now: 2 Gaps and 1.3.3 waiting, one Control Evidenced (story 11)", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("seeded");

    // As of the seed's now, not the clock: the demo's Scans age out of the 30 days.
    const answer = await createAuditReads(vouch).answer(team, NOW);

    expect(answer).toMatchObject({ answer: "not_yet", gaps: 2, waiting: 1 });
    expect(
      answer.controls.map(({ ref, verdict, review_state, gap }) => ({
        ref,
        verdict,
        review_state,
        gap,
      })),
    ).toEqual([
      { ref: "1.3.3", verdict: "not_evidenced", review_state: "not_reviewed", gap: false },
      { ref: "1.3.4", verdict: "partly_evidenced", review_state: "reviewed", gap: true },
      { ref: "4.1.3", verdict: "not_evidenced", review_state: "reviewed", gap: true },
      { ref: "5.2.4", verdict: "evidenced", review_state: "reviewed", gap: false },
    ]);
    expect(await createAuditReads(vouch).auditReady(team)).toBe(false);
  });

  it("cites the demo secret under 4.1.3, and the Open .env Finding and a demo Product CVE under 1.3.4", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW });
    const { id: product } = await expectOneDemoProduct(team);

    const controls = await judgeCatalogue(vouch, team, VDA_ISA_2027_1, NOW);

    const cited = (ref: string) =>
      controls.find((control) => control.ref === ref)?.evidence.open_findings ?? [];
    expect(cited("4.1.3").map(({ id }) => id)).toContain((await demoFinding(team, "secret")).id);
    const under134 = cited("1.3.4");
    expect(under134.map(({ id }) => id)).toContain((await demoFinding(team, "envLocal")).id);
    expect(
      under134.some(
        (f) =>
          f.rule_id === "patch/known-vulnerability" &&
          f.asset.kind === "product" &&
          f.asset.ref === product,
      ),
    ).toBe(true);
  });

  it("links the demo Repo, turns ISA2027 on and confirms 1.3.4, 4.1.3 and 5.2.4 as the oldest Admin or Lead", async () => {
    const team = await teamWith([
      ["user_member", "member"],
      ["user_lead", "lead"],
    ]);

    await seedDemo({ pool, team, now: NOW });

    await expectVouchState(team, "user_lead");
    const [asset] = await repoAssets.list(team);
    expect(asset?.installationId).toBe(demoInstallationId(team));
    expect(asset?.githubId).toBeGreaterThan(0);
  });

  it("run again after an Admin turns ISA2027 off and a Lead overrides 4.1.3, leaves both as they are", async () => {
    const team = await teamWith([
      ["user_admin", "admin"],
      ["user_lead", "lead"],
    ]);
    await seedDemo({ pool, team, now: NOW });
    await vouch.teamCatalogues.set(team, { catalogue: ISA, on: false, setBy: "user_admin" });
    await vouch.controlReviews.add(team, {
      catalogue: ISA,
      controlRef: "4.1.3",
      workedOutVerdict: "not_evidenced",
      outcome: "overridden",
      verdict: "not_applicable",
      reason: "No secrets in this Repo's history",
      reviewedBy: "user_lead",
    });
    const before = await stateOf(team);

    expect(await seedDemo({ pool, team, now: NOW })).toEqual({
      kind: "already_seeded",
      findings: before.findings.length,
    });
    expect(await stateOf(team)).toEqual(before);
  });

  it("on a rerun, gives a Team seeded before the Vouch step all of it, answering seeded", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedAsBeforeVouch(team);

    const result = await seedDemo({ pool, team, now: NOW });

    expect(result).toEqual({ kind: "seeded", findings: (await findings.list(team)).length });
    await expectOneDemoProduct(team);
    await expectVouchState(team, "user_admin");
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("already_seeded");
  });

  it("on a rerun, finishes a Vouch step cut short after 5.2.4's review, which keeps its one review", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await seedAsBeforeVouch(team);
    await vouch.controlReviews.add(team, {
      catalogue: ISA,
      controlRef: "5.2.4",
      workedOutVerdict: "evidenced",
      outcome: "confirmed",
      verdict: "evidenced",
      reason: "Demo seed: cut short",
      reviewedBy: "user_admin",
    });
    const [first] = await vouch.controlReviews.history(team, ISA, "5.2.4");

    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("seeded");

    await expectVouchState(team, "user_admin");
    expect(await vouch.controlReviews.history(team, ISA, "5.2.4")).toEqual([first]);
  });

  it("two Teams on one database each hold the demo Repo, under installations of their own", async () => {
    const teams = [
      await teamWith([["user_admin", "admin"]]),
      await teamWith([["user_admin", "admin"]]),
    ];

    for (const team of teams)
      expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("seeded");

    const held = await Promise.all(teams.map((team) => repoAssets.list(team)));
    expect(held.map((list) => list.map(({ ref }) => ref))).toEqual([[DEMO_REPO], [DEMO_REPO]]);
    const [first, second] = held.map(([asset]) => asset?.installationId);
    expect(first).not.toBe(second);
  });

  it("rejects with InstallationLinkedElsewhere when another Team holds the demo installation, and a rerun after finishes it", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const other = await teamWith([["user_other", "admin"]]);
    const installationId = demoInstallationId(team);
    await repoAssets.link(other, { installationId, linkedBy: "user_other", repos: [] });

    await expect(seedDemo({ pool, team, now: NOW })).rejects.toBeInstanceOf(
      InstallationLinkedElsewhere,
    );
    await expectNoVouchState(team);

    // The cause fixed: the other Team's link of it is gone.
    await withTeam(other, (tx) =>
      tx
        .deleteFrom("github_installations")
        .where("installation_id", "=", String(installationId))
        .execute(),
    );
    expect((await seedDemo({ pool, team, now: NOW })).kind).toBe("seeded");
    await expectVouchState(team, "user_admin");
  });
});

describe("pnpm seed", () => {
  // WARDEN_SEED_DEMO names the database, as a hosted one needs: the process gets the test's HOME, and a ~/.pgpass there
  // makes the database count as hosted (#396).
  const env = () => ({
    PGUSER: "warden_app",
    PGDATABASE: inject("testDatabase"),
    WARDEN_SEED_DEMO: inject("testDatabase"),
  });

  it("seeds the Team named on the command line as warden_app, and says what it did", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], env());

    expect(output).toContain(`"message":"demo Findings, demo Product and ISA2027 seeded"`);
    expect(code).toBe(0);
    expect(await demoFindingsOf(team)).toHaveLength(DEMO_COUNT);
  });

  it("adds the demo Product to a Team seeded without it, its secret under the old Rule id and envLocal Accepted", async () => {
    // The preview's case: warden_preview was seeded before 7cfe35b and before the demo Product, then decided.
    const team = await teamWith([["user_admin", "admin"]]);
    await seedDemo({ pool, team, now: NOW, withProduct: false });
    await asSeededBeforeRename(team);
    await findings.accept(team, (await demoFinding(team, "envLocal")).id, {
      actor: lead,
      reason: "Not reachable here",
      until: "2027-01-01T00:00:00Z",
    });

    const { code, output } = await runInServer(["node", "src/seed.ts", team], env());

    expect(output).toContain(`"message":"demo Findings, demo Product and ISA2027 seeded"`);
    expect(code).toBe(0);
    await expectOneDemoProduct(team);
  });

  it("exits 1 through 'demo seed failed' when another Team holds the demo installation, naming the error", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    const other = await teamWith([["user_other", "admin"]]);
    await repoAssets.link(other, {
      installationId: demoInstallationId(team),
      linkedBy: "user_other",
      repos: [],
    });

    const { code, output } = await runInServer(["node", "src/seed.ts", team], env());

    expect(code).toBe(1);
    expect(output).toContain(`"message":"demo seed failed"`);
    expect(output).toContain("InstallationLinkedElsewhere");
  });

  it("exits 1 for a Team with Products of its own, saying so", async () => {
    const team = await teamWith([["user_admin", "admin"]]);
    await products.create(team, { name: "Billing", repo_urls: [], dependencies: [] });

    const { code, output } = await runInServer(["node", "src/seed.ts", team], env());

    expect(code).toBe(1);
    expect(output).toContain("has Products of its own");
    expect(await findings.list(team)).toEqual([]);
  });

  it("exits 1 for an argument after the Team id it doesn't know, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(
      ["node", "src/seed.ts", team, "--no-prodcut"],
      env(),
    );

    expect(code).toBe(1);
    expect(output).toContain("--no-prodcut");
    expect(await findings.list(team)).toEqual([]);
  });

  it("exits 1 when a flag comes before the Team id, rather than taking it for the Team, writing nothing", async () => {
    const team = await teamWith([["user_admin", "admin"]]);

    const { code, output } = await runInServer(
      ["node", "src/seed.ts", "--no-product", team],
      env(),
    );

    expect(code).toBe(1);
    expect(output).toContain("Name the Team to seed first");
    expect(await findings.list(team)).toEqual([]);
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

  it("refuses the live database with HOME unset and a .pgpass in the folder it runs from (#476)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "warden-seed-cwd-"));
    try {
      writeFileSync(join(folder, ".pgpass"), "");

      // Only what the case needs, HOME left out. PGPORT is a port nothing listens on, so a seed that got past the guard
      // couldn't reach any database.
      const { code, output } = await runCommand(
        ["node", fileURLToPath(new URL("../src/seed.ts", import.meta.url)), newTeam()],
        {
          PGHOST: "127.0.0.1",
          PGPORT: "1",
          PGDATABASE: "warden",
          WARDEN_SEED_DEMO: "1",
          HOME: undefined,
        },
        { cwd: folder, clean: true },
      );

      expect(code).toBe(1);
      expect(output).toContain("demo seed refused");
      expect(output).toContain("live database, warden");
      expect(output).toContain("./.pgpass exists");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
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

describe("the demo seed with the CVE snapshot not loaded", () => {
  let own: Awaited<ReturnType<typeof ownDatabase<"warden_app">>>;
  let ownFindings: Findings;
  let ownProducts: Products;

  beforeAll(async () => {
    own = await ownDatabase(["warden_app"]);
    ownFindings = createFindings({ withTeam: own.withTeamAs.warden_app, moveRules: {} });
    ownProducts = createProducts({ withTeam: own.withTeamAs.warden_app });
  }, 30_000);

  afterAll(() => own.end(), 30_000);

  const ownTeam = async () => {
    const team = newTeam();
    await seedTeam(own.withTeamAs.warden_app, team, [["user_admin", "admin"]]);
    return team;
  };
  const ownEnv = () => ({ PGUSER: "warden_app", PGDATABASE: own.name, WARDEN_SEED_DEMO: own.name });

  it("answers no_cve_snapshot and writes no Product or Finding", async () => {
    const team = await ownTeam();

    expect(await seedDemo({ pool: own.pools.warden_app, team, now: NOW })).toEqual({
      kind: "no_cve_snapshot",
    });
    expect(await ownProducts.list(team)).toEqual([]);
    expect(await ownFindings.list(team)).toEqual([]);
  });

  it("as a command, exits 1 naming load-cves", async () => {
    const team = await ownTeam();

    const { code, output } = await runInServer(["node", "src/seed.ts", team], ownEnv());

    expect(code).toBe(1);
    expect(output).toContain("load-cves");
    expect(await ownFindings.list(team)).toEqual([]);
  });

  it("with --no-product, seeds the demo Findings and no Product, and run again with it is already seeded", async () => {
    const team = await ownTeam();

    const first = await runInServer(["node", "src/seed.ts", team, "--no-product"], ownEnv());

    expect(first.output).toContain(`"message":"demo Findings seeded"`);
    expect(first.code).toBe(0);
    const before = await ownFindings.list(team);
    expect(before).toHaveLength(DEMO_COUNT);
    expect(await ownProducts.list(team)).toEqual([]);

    const again = await runInServer(["node", "src/seed.ts", team, "--no-product"], ownEnv());

    expect(again.output).toContain("already seeded");
    expect(again.code).toBe(0);
    expect(await ownFindings.list(team)).toEqual(before);
  });

  it("run again without --no-product on a Team seeded with it, exits 1 naming load-cves, writing nothing", async () => {
    const team = await ownTeam();
    await runInServer(["node", "src/seed.ts", team, "--no-product"], ownEnv());
    const before = await ownFindings.list(team);

    const { code, output } = await runInServer(["node", "src/seed.ts", team], ownEnv());

    expect(code).toBe(1);
    expect(output).toContain("load-cves");
    expect(await ownProducts.list(team)).toEqual([]);
    expect(await ownFindings.list(team)).toEqual(before);
  });
});
