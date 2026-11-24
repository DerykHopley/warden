// The demo seed: the demo Findings (`@warden/contracts/demo`) in one Team, so local development and an owner preview
// show a filled Findings page. It writes only through the Findings module, as a module and a Lead would: Scans through
// `reconcile`, a Spot run through `report`, and two named decisions made as the Team's oldest Admin or Lead. The
// browser tests seed their Teams with it too.
//
// As its own process: `WARDEN_SEED_DEMO=1 pnpm --filter @warden/server seed <team-id>`, the Team being the Clerk
// Organization id (`org_…`) that the Team's Admin has already opened Warden in. See `seedRefusal` for when it refuses
// to start. It connects as the PG* variables say (`pnpm seed` sets warden_app), with the server's role check on
// connect: a role that can get around row-level security exits 1. Exit 0 when seeded or already seeded; 1 otherwise,
// naming why.
import {
  fingerprint,
  problemKeyOf,
  type Finding,
  type Location,
  type Observation,
} from "@warden/contracts";
import {
  DEMO_ACCEPTED_DAYS,
  DEMO_OBSERVATIONS,
  DEMO_OUTCOME,
  DEMO_RUN_IDS,
  demoRuns,
  type DemoKey,
} from "@warden/contracts/demo";
import { sql } from "kysely";
import type pg from "pg";
import { createPool, guardDatabaseRole } from "./database.ts";
import { createFindings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import { createWithTeam } from "./with-team.ts";

export type SeedResult =
  | { kind: "seeded"; findings: number }
  /** Every demo run was already applied, and the Findings are as the seed leaves them: nothing was written. */
  | { kind: "already_seeded"; findings: number }
  /** Warden has no such Team: its Admin hasn't opened Warden in it yet. */
  | { kind: "no_team" }
  /** The Team has no Admin or Lead to make the demo decisions. */
  | { kind: "no_lead" }
  /** The Team has Findings the seed didn't write: nothing was written. */
  | { kind: "other_findings"; findings: number }
  /** The demo Findings aren't as the seed leaves them (a seed cut short, or changed since). */
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

/** How `list` differs from what the seed leaves, one line per difference; empty when it matches. */
function differences(list: readonly Finding[]): string[] {
  const found = demoFindingsIn(list);
  const problems: string[] = [];
  for (const [name, want] of Object.entries(DEMO_OUTCOME) as [
    DemoKey,
    (typeof DEMO_OUTCOME)[DemoKey],
  ][]) {
    const finding = found[name];
    if (finding === undefined) {
      problems.push(`${name}: missing (want ${want.status})`);
      continue;
    }
    if (finding.status !== want.status) {
      problems.push(`${name}: ${finding.status} (want ${want.status})`);
    }
    const movedTo = want.unconfirmedFixTo && found[want.unconfirmedFixTo]?.id;
    const candidates = finding.unconfirmed_fix?.candidates ?? [];
    if (movedTo ? !candidates.includes(movedTo) : candidates.length > 0) {
      problems.push(`${name}: Unconfirmed fix ${JSON.stringify(candidates)}`);
    }
  }
  const extra = list.length - Object.keys(found).length;
  if (extra > 0) problems.push(`${extra} Finding(s) the seed didn't write`);
  return problems;
}

/**
 * Seeds `team` with the demo Findings, as of `now`, through connections from `pool` (warden_app). One seed runs per
 * Team at a time: a second waits for the first, then finds the Team seeded. A Team is seeded when every demo run id is
 * applied and its Findings are as the seed leaves them; one with Findings of its own is left as it is.
 */
export async function seedDemoFindings({
  pool,
  team,
  now = new Date(),
}: {
  pool: pg.Pool;
  team: string;
  now?: Date;
}): Promise<SeedResult> {
  const withTeam = createWithTeam(pool);
  // Every module's move rule, as the server wires them: the demo's Unconfirmed fix comes from Guard's.
  const findings = createFindings({
    withTeam,
    moveRules: { guard: guardMoveRule, patch: patchMoveRule },
  });

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
      others: await tx
        .selectFrom("findings")
        .select(sql<string>`count(*)`.as("count"))
        .where("first_seen_scan", "not in", [...DEMO_RUN_IDS])
        .executeTakeFirstOrThrow(),
    }));
    if (found.team === undefined) return { kind: "no_team" };
    if (found.lead === undefined) return { kind: "no_lead" };
    const others = Number(found.others.count);
    if (others > 0) return { kind: "other_findings", findings: others };

    if (found.runs.length > 0) {
      const list = await findings.list(team);
      const problems = differences(list);
      if (found.runs.length < DEMO_RUN_IDS.length) {
        problems.unshift(
          `only ${found.runs.length} of the ${DEMO_RUN_IDS.length} demo runs applied`,
        );
      }
      return problems.length === 0
        ? { kind: "already_seeded", findings: list.length }
        : { kind: "mismatch", problems };
    }

    const { scans, spotRun } = demoRuns(team, now);
    for (const scan of scans) await findings.reconcile(scan);
    await findings.report(spotRun);

    const actor = { kind: "person", id: found.lead.user_id } as const;
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

    const list = await findings.list(team);
    const problems = differences(list);
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
  const team = argv[0]?.trim();
  if (!team) {
    logger.error(
      "Name the Team to seed: pnpm --filter @warden/server seed <team-id> (its Clerk Organization id, org_…)",
    );
    return 1;
  }
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
    const result = await seedDemoFindings({ pool, team });
    switch (result.kind) {
      case "seeded":
        logger.info("demo Findings seeded", { team, findings: result.findings });
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
      case "mismatch":
        logger.error("The Team's demo Findings aren't as the seed leaves them", {
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
