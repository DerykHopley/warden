// The daily Job (ADR 0009): reopens every Team's Accepted Findings whose expiry has passed, then runs each module's
// daily step for the Team (`DailyStep`): Patch's CVE refresh, one Patch Scan per Product plus the sweep of Product
// Assets with no Product row; then Guard's, which deletes Agent events older than 7 days and starts a Judge run for
// each missed Agent session (#499). It lists the Team ids through `withAdmin` (warden_admin, which may read `teams (id)` and
// nothing else, read only), then changes each Team inside `withTeam` (warden_app), so row-level security binds every
// change. A Team's expiry or step failing is logged with its id (and the step's name) and the rest still run. It is
// a start-up file for ADR 0005, so it may import the modules.
//
// As its own process (`pnpm --filter @warden/server expire`, or the Cloud Run Job #24 makes):
// - WARDEN_DATABASE_ROLES picks the role set, as for the server; an unknown value exits 1 before connecting.
// - The app pool is the PG* variables', with the server's role check on connect: a role that can get around
//   row-level security exits 1, naming the role and why.
// - The admin pool takes the same host, port and database, with the set's admin role as its user and
//   WARDEN_ADMIN_PASSWORD as its password. With PGPASSWORD set and WARDEN_ADMIN_PASSWORD not, it exits 1 before
//   connecting: `pg` would send the app's password as the admin's. With neither set (compose and CI use trust auth),
//   it connects without one. Before listing, its `current_user` must be the set's admin role, without BYPASSRLS;
//   anything else exits 1.
// - The database unreachable, or a login refused: exit 1 with the error, nothing changed.
// - WARDEN_SCAN_JOB names the Cloud Run Job a Judge run starts as; without it, off Cloud Run a run starts as a child
//   process, and in a Cloud Run Job (CLOUD_RUN_JOB) none starts, so a Team with a missed session fails in part.
// It needs no Clerk variable and no model key. Exit 0 when every Team's expiry and steps ran; 1 otherwise (a Patch Scan before
// `load-cves` has run fails, changing nothing).
import type pg from "pg";
import {
  createPool,
  databaseRoleNames,
  guardDatabaseRole,
  type DatabaseRoleNames,
} from "./database.ts";
import { createFindings, DAILY_JOB_LIMITS, type Findings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { createAgentSessions } from "./modules/guard/agent-sessions.ts";
import { createGuardDailyStep } from "./modules/guard/daily-step.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import { createProducts } from "./modules/patch/products.ts";
import { createPatchRefresh } from "./modules/patch/refresh.ts";
import { createPatchScan } from "./modules/patch/scan.ts";
import { dailyJudgeJobStarterFor } from "./scan-job-starters.ts";
import { createWithAdmin, type WithAdmin } from "./with-admin.ts";
import { createWithTeam } from "./with-team.ts";

/**
 * One module's daily work for one Team, which the Job runs after the Team's expiry (Patch's CVE refresh; Guard's
 * delete and sweep). It does its database work inside `withTeam` for that Team.
 */
export interface DailyStep {
  /**
   * Named in the log when the step fails for a Team, and as its counts' key in the closing line, beside the Job's own
   * `teamsFailed`: the Teams it failed for, in part or whole.
   */
  name: string;
  /** `failed` when the Team's work failed in part (the step logs which part); throwing fails it whole. */
  run(team: string): Promise<{ failed: boolean; counts: Record<string, number> }>;
}

export async function runDailyExpiry({
  withAdmin,
  findings,
  steps = [],
  logger,
  now = new Date(),
}: {
  withAdmin: WithAdmin;
  findings: Pick<Findings, "expireAcceptances">;
  /** Run for each Team after its expiry, in order, each in its own `try`. */
  steps?: DailyStep[];
  logger: Logger;
  now?: Date;
}): Promise<0 | 1> {
  let teams: string[];
  try {
    teams = await withAdmin(async (tx) =>
      (await tx.selectFrom("teams").select("id").orderBy("id").execute()).map((team) => team.id),
    );
  } catch (error) {
    logger.error("daily expiry: listing the Teams failed; nothing was changed", { error });
    return 1;
  }
  if (teams.length === 0) {
    // An empty list is also what the admin role sees without its policy: it can't tell the two apart.
    logger.warn(
      "daily expiry: no Team listed. On a database with Teams, the admin role is missing the " +
        "teams_admin_lists_ids policy or its select (id) grant on teams (0006_proposals)",
    );
  }

  let failed = 0;
  let reopened = 0;
  // Each step's counts, summed over the Teams, and the Teams it failed for (in part, or thrown whole), so a step that
  // threw for a Team never reads as clean.
  const stepCounts: Record<string, Record<string, number>> = {};
  for (const step of steps) stepCounts[step.name] = { teamsFailed: 0 };
  for (const team of teams) {
    let teamFailed = false;
    try {
      reopened += (await findings.expireAcceptances(team, now)).length;
    } catch (error) {
      teamFailed = true;
      logger.error("daily expiry: a Team failed; the others still run", { team, error });
    }
    for (const step of steps) {
      const sums = stepCounts[step.name]!;
      try {
        const { failed: stepFailed, counts } = await step.run(team);
        for (const [key, n] of Object.entries(counts)) sums[key] = (sums[key] ?? 0) + n;
        if (stepFailed) {
          teamFailed = true;
          sums.teamsFailed = (sums.teamsFailed ?? 0) + 1;
          logger.error("daily expiry: a step failed in part for a Team; the rest still run", {
            team,
            step: step.name,
          });
        }
      } catch (error) {
        teamFailed = true;
        sums.teamsFailed = (sums.teamsFailed ?? 0) + 1;
        logger.error("daily expiry: a step failed for a Team; the rest still run", {
          team,
          step: step.name,
          error,
        });
      }
    }
    if (teamFailed) failed += 1;
  }
  logger.info("daily expiry done", {
    teamsVisited: teams.length,
    teamsFailed: failed,
    findingsReopened: reopened,
    steps: stepCounts,
  });
  return failed > 0 ? 1 : 0;
}

/**
 * Throws unless the admin pool's connections are the set's admin role, without BYPASSRLS: one that has it reads every
 * Team's rows, not only their ids.
 */
export async function checkAdminRole(
  admin: Pick<pg.Pool, "query">,
  names: Pick<DatabaseRoleNames, "admin">,
): Promise<void> {
  const { rows } = await admin.query<{ role: string; bypassrls: boolean }>(
    `select current_user as role, rolbypassrls as bypassrls from pg_roles where rolname = current_user`,
  );
  const found = rows[0];
  if (found?.role !== names.admin) {
    throw new Error(
      `the admin connection is ${found?.role}, not ${names.admin}: the daily Job lists Teams only as the admin role`,
    );
  }
  if (found.bypassrls) {
    throw new Error(
      `${found.role} has BYPASSRLS: it would read every Team's rows. Run roles as a superuser to take it away`,
    );
  }
}

async function main(env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  let names: DatabaseRoleNames;
  try {
    names = databaseRoleNames(env);
  } catch (error) {
    logger.error("daily expiry failed before connecting", { error });
    return 1;
  }
  if (env.PGPASSWORD && !env.WARDEN_ADMIN_PASSWORD) {
    logger.error(
      "daily expiry failed before connecting: PGPASSWORD is set but WARDEN_ADMIN_PASSWORD isn't. " +
        `Set it to ${names.admin}'s password (warden-db-admin-password); the app's isn't sent in its place`,
    );
    return 1;
  }
  const app = createPool(logger, {
    max: 2,
    onConnect: guardDatabaseRole(({ role, reason }) => {
      logger.error(`daily expiry: its database role can bypass row-level security. ${reason}.`, {
        role,
        reason,
      });
    }),
  });
  const admin = createPool(logger, {
    max: 1,
    user: names.admin,
    password: env.WARDEN_ADMIN_PASSWORD || undefined,
  });
  try {
    // Both connections, and both roles, are checked before anything is read.
    await app.query("select 1");
    await checkAdminRole(admin, names);
    const withTeam = createWithTeam(app);
    // ADR 0005: this start-up file wires the modules in, with the server's move rules, as index.ts does.
    const findings = createFindings({
      withTeam,
      moveRules: { guard: guardMoveRule, patch: patchMoveRule },
    });
    return await runDailyExpiry({
      withAdmin: createWithAdmin(admin),
      findings,
      steps: [
        createPatchRefresh({
          products: createProducts({ withTeam }),
          findings,
          // The expiry's limits, so one Team stuck behind its lock fails its Scans instead of hanging the Job.
          scan: createPatchScan({ findings, logger, limits: DAILY_JOB_LIMITS }),
          logger,
        }),
        createGuardDailyStep({
          agentSessions: createAgentSessions({ withTeam }),
          startJudgeJob: dailyJudgeJobStarterFor(env, { logger }),
          logger,
        }),
      ],
      logger,
    });
  } catch (error) {
    logger.error("daily expiry failed; nothing was changed", { error });
    return 1;
  } finally {
    await Promise.all([app.end(), admin.end()]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.env, createLogger());
}
