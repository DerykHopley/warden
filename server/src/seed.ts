// The demo seed: the demo Findings (`@warden/contracts/demo`) in one Team, so local development and an owner preview
// show a filled Findings page. It writes only through the Findings module, as a module and a Lead would: Scans through
// `reconcile`, a Spot run through `report`, and two named decisions made as the Team's oldest Admin or Lead. Then it
// creates the demo Product (`DEMO_PRODUCT`) through the Products store and runs its Patch Scan, as a save does, so the
// Product's CVE Findings come from the loaded CVE snapshot. The browser tests seed their Teams with it too, without
// the Product (`--no-product`), so the Findings their tests count stay the demo ones.
//
// As its own process: `WARDEN_SEED_DEMO=1 pnpm --filter @warden/server seed <team-id> [--no-product]`, the Team being
// the Clerk Organization id (`org_…`) that the Team's Admin has already opened Warden in. See `seedRefusal` for when
// it refuses to start. It connects as the PG* variables say (`pnpm seed` sets warden_app), with the server's role
// check on connect: a role that can get around row-level security exits 1. Exit 0 when seeded or already seeded; 1
// otherwise, naming why.
import { isDeepStrictEqual } from "node:util";
import {
  fingerprint,
  problemKeyOf,
  type Finding,
  type Location,
  type Observation,
  type Product,
} from "@warden/contracts";
import {
  DEMO_ACCEPTED_DAYS,
  DEMO_OBSERVATIONS,
  DEMO_OUTCOME,
  DEMO_PRODUCT,
  DEMO_RUN_IDS,
  demoRuns,
  type DemoKey,
} from "@warden/contracts/demo";
import { sql } from "kysely";
import type pg from "pg";
import { createPool, guardDatabaseRole } from "./database.ts";
import { createFindings, type HistoryEntry } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { createProducts } from "./modules/patch/products.ts";
import { createPatchScan, PATCH_RULE } from "./modules/patch/scan.ts";
import { MOVE_RULES } from "./wiring.ts";
import { createWithTeam } from "./with-team.ts";

export type SeedResult =
  /** `findings` counts every Finding of the Team: the demo ones and the demo Product's CVE Findings. */
  | { kind: "seeded"; findings: number }
  /**
   * Every demo run and the seed's decisions were already applied, and (with the Product) the demo Product is as the
   * seed leaves it: nothing was written. The demo Findings count as they are, whatever has been decided on them since.
   */
  | { kind: "already_seeded"; findings: number }
  /** Warden has no such Team: its Admin hasn't opened Warden in it yet. */
  | { kind: "no_team" }
  /** The Team has no Admin or Lead to make the demo decisions. */
  | { kind: "no_lead" }
  /** Not yet seeded, the Team has Findings of its own: nothing was written. (Once seeded, they are a mismatch.) */
  | { kind: "other_findings"; findings: number }
  /** The CVE snapshot isn't loaded, so the demo Product's Scan can't run: nothing was written. */
  | { kind: "no_cve_snapshot" }
  /** Not yet seeded, the Team has Products of its own: nothing was written, and none of them changed. */
  | { kind: "other_products"; products: number }
  /**
   * The seed didn't finish, or the Team holds more than it wrote: demo runs not all applied, the seed's decisions
   * missing, a Finding the seed didn't write, or a demo Product not as `DEMO_PRODUCT`. Nothing was written.
   */
  | { kind: "mismatch"; problems: string[] };

/** The hosts that are this machine: the compose database, or a local socket when PGHOST is unset. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** The live database's name on Cloud SQL (README, Setting up Google Cloud). */
const LIVE_DATABASE = "warden";

/**
 * Why the seed won't run against the database the PG* variables name, or undefined when it may. WARDEN_SEED_DEMO must
 * be set. A hosted database (PGHOST not this machine, or a password set: the Cloud SQL Auth Proxy listens on
 * 127.0.0.1) needs WARDEN_SEED_DEMO to name it, and is never the live database.
 */
export function seedRefusal(env: Record<string, string | undefined>): string | undefined {
  const asked = env.WARDEN_SEED_DEMO;
  if (!asked) {
    return "Set WARDEN_SEED_DEMO to seed demo Findings (any value locally; the database's name on a hosted one)";
  }
  const hosted = (env.PGHOST !== undefined && !LOCAL_HOSTS.has(env.PGHOST)) || !!env.PGPASSWORD;
  if (!hosted) return undefined;
  if (env.PGDATABASE === LIVE_DATABASE) {
    return `The demo seed never writes to the live database, ${LIVE_DATABASE}`;
  }
  if (asked !== env.PGDATABASE) {
    return `On a hosted database, WARDEN_SEED_DEMO must name the database, ${env.PGDATABASE}`;
  }
  return undefined;
}

const keyOf = (observation: Observation) =>
  problemKeyOf(
    observation.asset,
    fingerprint(observation.rule_id, observation.location as Location),
  );

/** Each demo Finding in `list`, by its demo name. */
function demoFindingsIn(list: readonly Finding[]): Partial<Record<DemoKey, Finding>> {
  const byProblem = new Map(list.map((f) => [problemKeyOf(f.asset, f.fingerprint), f]));
  return Object.fromEntries(
    (Object.entries(DEMO_OBSERVATIONS) as [DemoKey, Observation][]).flatMap(([name, o]) => {
      const finding = byProblem.get(keyOf(o));
      return finding ? [[name, finding]] : [];
    }),
  );
}

/**
 * Whether `finding` is one of the demo Findings: a demo run first saw it. Not found by today's demo data, so one stored
 * under an older demo Rule id (and its fingerprint) is still the seed's own.
 */
const isDemoFinding = (finding: Finding) =>
  (DEMO_RUN_IDS as readonly string[]).includes(finding.first_seen_scan);

/** The seed's named decisions (each with a `Demo seed:` reason): one line for each that no entry in `histories` holds. */
function missingDecisions(histories: readonly HistoryEntry[]): string[] {
  return (Object.entries(DEMO_OUTCOME) as [DemoKey, (typeof DEMO_OUTCOME)[DemoKey]][]).flatMap(
    ([name, want]) => {
      if (want.decidedReason === undefined) return [];
      const made = histories.some(
        (entry) =>
          entry.cause.kind === "person" &&
          entry.status_after === want.status &&
          entry.reason === want.decidedReason,
      );
      return made ? [] : [`${name}: the seed's decision (${want.status}) is missing`];
    },
  );
}

/** The Team's demo Product, by its name: a first seed with the Product refuses a Team that already has one, so it's
 * the seed's own unless a Lead named one so after a seed without it (then it must match `DEMO_PRODUCT`). Names
 * compare as the name index (`lower(btrim(name))`) does: whatever their case and the spaces around them. */
const demoProductIn = (products: readonly Product[]) => {
  const key = (name: string) => name.replace(/^ +| +$/g, "").toLowerCase();
  return products.find((product) => key(product.name) === key(DEMO_PRODUCT.name));
};

/** Whether `finding` is on Product `id`'s Asset. On the demo Product's, it is one of the seed's own. */
export const onProduct = (finding: Finding, id: string | undefined) =>
  id !== undefined && finding.asset.kind === "product" && finding.asset.ref === id;

/**
 * How the demo Product differs from what the seed leaves, one line each, naming "demo Product"; empty when it is as
 * `DEMO_PRODUCT` with at least one CVE Finding on it, in any Status (a Lead may have decided each one since). The
 * number of CVE Findings isn't fixed: a newer snapshot changes it.
 */
function productProblems(product: Product, list: readonly Finding[]): string[] {
  const problems: string[] = [];
  const { id, ...stored } = product;
  if (!isDeepStrictEqual(stored, DEMO_PRODUCT)) {
    problems.push(`demo Product: ${JSON.stringify(stored)} (want ${JSON.stringify(DEMO_PRODUCT)})`);
  }
  if (!list.some((f) => onProduct(f, id) && f.rule_id === PATCH_RULE)) {
    problems.push("demo Product: no CVE Finding");
  }
  return problems;
}

/**
 * Seeds `team` with the demo Findings, then (`withProduct`, the default) the demo Product and its Patch Scan, as of
 * `now`, through connections from `pool` (warden_app). One seed runs per Team at a time: a second waits for the first,
 * then finds the Team seeded. A Team is seeded when every demo run id is applied, the seed's two decisions are in its
 * demo Findings' history, every other Finding is on the demo Product's Asset, and (`withProduct`) its demo Product is
 * as `DEMO_PRODUCT` with a CVE Finding. The demo Findings (the ones a demo run first saw) are taken as they are: their
 * Statuses, decisions and Rule ids since the seed aren't compared with today's demo data, and a rerun never changes
 * them. A Team seeded without the demo Product (`withProduct` false, or a Product step
 * cut short) gets it on a rerun with it. One with Findings of its own, or (`withProduct`, not yet seeded) Products of
 * its own, is left as it is; so is every Team when the CVE snapshot the Product's Scan needs isn't loaded. `logger`
 * takes the Scan's log lines.
 */
export async function seedDemo({
  pool,
  team,
  now = new Date(),
  withProduct = true,
  logger = createLogger(),
}: {
  pool: pg.Pool;
  team: string;
  now?: Date;
  withProduct?: boolean;
  logger?: Logger;
}): Promise<SeedResult> {
  const withTeam = createWithTeam(pool);
  // Every module's move rule, as the server wires them: the demo's Unconfirmed fix comes from Guard's.
  const findings = createFindings({ withTeam, moveRules: MOVE_RULES });
  const products = createProducts({ withTeam });

  /**
   * The Team's Findings, its demo Product if it has one, and how the Team differs from what the seed leaves, given
   * `runsApplied` of the demo runs applied. The demo Findings are taken as they are now: a Lead's decisions, the daily
   * Job's and a rename of a demo Rule id since the seed are no problem. The problems: demo runs not all applied; with
   * them all, the seed's two decisions missing from the demo Findings' history (a seed cut short before them); any
   * Finding neither a demo one nor on the demo Product's Asset; and (`withProduct`) a demo Product not as the seed
   * leaves it. A missing demo Product isn't one: the caller decides whether the seed still has to create it.
   */
  async function check(runsApplied: number) {
    const list = await findings.list(team);
    const demo = demoProductIn(await products.list(team));
    const problems: string[] = [];
    if (runsApplied < DEMO_RUN_IDS.length) {
      problems.push(`only ${runsApplied} of the ${DEMO_RUN_IDS.length} demo runs applied`);
    } else {
      const histories: HistoryEntry[] = [];
      for (const finding of list.filter(isDemoFinding)) {
        histories.push(...(await findings.history(team, finding.id)));
      }
      problems.push(...missingDecisions(histories));
    }
    const extra = list.filter((f) => !isDemoFinding(f) && !onProduct(f, demo?.id)).length;
    if (extra > 0) problems.push(`${extra} Finding(s) the seed didn't write`);
    if (withProduct && demo !== undefined) problems.push(...productProblems(demo, list));
    return { list, demo, problems };
  }

  /** The demo runs, then the two named decisions, made as Admin or Lead `lead`. */
  async function writeDemoFindings(lead: string) {
    const { scans, spotRun } = demoRuns(team, now);
    for (const scan of scans) await findings.reconcile(scan);
    await findings.report(spotRun);

    const actor = { kind: "person", id: lead } as const;
    const seeded = demoFindingsIn(await findings.list(team));
    const idOf = (name: DemoKey) => {
      const id = seeded[name]?.id;
      if (id === undefined) throw new Error(`the demo seed lost its ${name} Finding`);
      return id;
    };
    await findings.accept(team, idOf("axios"), {
      actor,
      reason: DEMO_OUTCOME.axios.decidedReason!,
      until: new Date(now.getTime() + DEMO_ACCEPTED_DAYS * 24 * 3600_000).toISOString(),
    });
    await findings.markFalsePositive(team, idOf("push"), {
      actor,
      reason: DEMO_OUTCOME.push.decidedReason!,
    });
  }

  const lock = await pool.connect();
  const key = `demo_seed:${team}`;
  await lock.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
  try {
    const found = await withTeam(team, async (tx) => ({
      team: await tx.selectFrom("teams").select("id").executeTakeFirst(),
      lead: await tx
        .selectFrom("team_members")
        .select("user_id")
        .where("role", "in", ["lead", "admin"])
        .orderBy("joined_at")
        .orderBy("user_id")
        .executeTakeFirst(),
      runs: await tx
        .selectFrom("scans")
        .select("id")
        .where("id", "in", [...DEMO_RUN_IDS])
        .execute(),
      // Only counted before a seed: once a demo run is applied, check() names every Finding the seed didn't write:
      // neither first seen by a demo run nor on the demo Product's Asset (its Scan's ids are random).
      others: await tx
        .selectFrom("findings")
        .select(sql<string>`count(*)`.as("count"))
        .where("first_seen_scan", "not in", [...DEMO_RUN_IDS])
        .executeTakeFirstOrThrow(),
      products: await tx
        .selectFrom("products")
        .select(sql<string>`count(*)`.as("count"))
        .executeTakeFirstOrThrow(),
      snapshot: await tx.selectFrom("cve_snapshot").select("as_of").executeTakeFirst(),
    }));
    if (found.team === undefined) return { kind: "no_team" };
    if (found.lead === undefined) return { kind: "no_lead" };

    if (found.runs.length > 0) {
      const { list, demo, problems } = await check(found.runs.length);
      if (problems.length > 0) return { kind: "mismatch", problems };
      if (!withProduct || demo !== undefined) {
        return { kind: "already_seeded", findings: list.length };
      }
      // Seeded without the demo Product (with --no-product, before the seed made one, or a Product step cut short
      // after the Findings): the rest of this run finishes it.
      if (found.snapshot === undefined) return { kind: "no_cve_snapshot" };
    } else {
      const others = Number(found.others.count);
      if (others > 0) return { kind: "other_findings", findings: others };
      if (withProduct && found.snapshot === undefined) return { kind: "no_cve_snapshot" };
      const ownProducts = Number(found.products.count);
      if (withProduct && ownProducts > 0) {
        return { kind: "other_products", products: ownProducts };
      }
      await writeDemoFindings(found.lead.user_id);
    }

    if (withProduct) {
      // As a save does: the Product, then its Scan against the loaded snapshot.
      const { id } = await products.create(team, DEMO_PRODUCT);
      await createPatchScan({ findings, logger }).scanProduct(team, { id });
    }

    // Every demo run is applied by now: this run applied them, or found them all applied.
    const { list, demo, problems } = await check(DEMO_RUN_IDS.length);
    if (withProduct && demo === undefined) {
      problems.push(`demo Product: missing (no Product named ${DEMO_PRODUCT.name})`);
    }
    return problems.length === 0
      ? { kind: "seeded", findings: list.length }
      : { kind: "mismatch", problems };
  } finally {
    await lock.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
    lock.release();
  }
}

async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  logger: Logger,
): Promise<number> {
  const refusal = seedRefusal(env);
  if (refusal !== undefined) {
    logger.error(`demo seed refused: ${refusal}`);
    return 1;
  }
  const [first, ...rest] = argv;
  const team = first?.trim();
  if (!team) {
    logger.error(
      "Name the Team to seed: pnpm --filter @warden/server seed <team-id> [--no-product] (its Clerk Organization id, org_…)",
    );
    return 1;
  }
  if (team.startsWith("--")) {
    logger.error(
      `Name the Team to seed first, then ${team}: pnpm --filter @warden/server seed <team-id> [--no-product]`,
    );
    return 1;
  }
  const unknown = rest.filter((arg) => arg !== "--no-product");
  if (unknown.length > 0) {
    logger.error("demo seed: unknown argument(s) after the Team id; only --no-product is known", {
      arguments: unknown,
    });
    return 1;
  }
  const withProduct = !rest.includes("--no-product");
  const pool = createPool(logger, {
    max: 3,
    onConnect: guardDatabaseRole(({ role, reason }) => {
      logger.error(`demo seed: its database role can bypass row-level security. ${reason}.`, {
        role,
        reason,
      });
    }),
  });
  try {
    const result = await seedDemo({ pool, team, withProduct, logger });
    switch (result.kind) {
      case "seeded":
        logger.info(
          withProduct ? "demo Findings and demo Product seeded" : "demo Findings seeded",
          {
            team,
            findings: result.findings,
          },
        );
        return 0;
      case "already_seeded":
        logger.info("the Team is already seeded; nothing changed", {
          team,
          findings: result.findings,
        });
        return 0;
      case "no_team":
        logger.error(
          "Warden has no such Team. Open Warden as the Team's Admin first, then seed it",
          { team },
        );
        return 1;
      case "no_lead":
        logger.error("The Team has no Admin or Lead to make the demo decisions", { team });
        return 1;
      case "other_findings":
        logger.error("The Team has Findings of its own; nothing seeded", {
          team,
          findings: result.findings,
        });
        return 1;
      case "no_cve_snapshot":
        logger.error(
          "The CVE snapshot isn't loaded, so the demo Product can't be scanned; nothing seeded. Run " +
            "PGUSER=warden_migrate pnpm --filter @warden/server load-cves first, or seed with --no-product",
          { team },
        );
        return 1;
      case "other_products":
        logger.error("The Team has Products of its own; nothing seeded", {
          team,
          products: result.products,
        });
        return 1;
      case "mismatch":
        logger.error("The Team's demo Findings or demo Product aren't as the seed leaves them", {
          team,
          problems: result.problems,
        });
        return 1;
    }
  } catch (error) {
    logger.error("demo seed failed", { error });
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, createLogger());
}
