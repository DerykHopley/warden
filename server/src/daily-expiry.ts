// The daily Job (ADR 0009): reopens every Team's Accepted Findings whose expiry has passed. It lists the Team ids
// through `withAdmin` (warden_admin, which may read `teams (id)` and nothing else, read only), then changes each Team
// inside `withTeam` (warden_app), so row-level security binds every change. One Team failing is logged with its id and
// the rest still run.
//
// As its own process (`pnpm --filter @warden/server expire`, or the Cloud Run Job #24 makes):
// - WARDEN_DATABASE_ROLES picks the role set, as for the server; an unknown value exits 1 before connecting.
// - The app pool is the PG* variables', with the server's role check on connect: a role that can get around
//   row-level security exits 1, naming the role and why.
// - The admin pool takes the same host, port and database, with the set's admin role as its user (WARDEN_ADMIN_USER
//   overrides it, to check the check) and WARDEN_ADMIN_PASSWORD as its password (unset: none, as compose and CI use
//   trust auth). Before listing, its `current_user` must be the set's admin role; anything else exits 1.
// - The database unreachable, or a login refused: exit 1 with the error, nothing changed.
// It needs no Clerk variable. Exit 0 when every Team ran; 1 otherwise.
import type pg from "pg";
import {
  createPool,
  databaseRoleNames,
  guardDatabaseRole,
  type DatabaseRoleNames,
} from "./database.ts";
import { createFindings, type Findings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { createWithAdmin, type WithAdmin } from "./with-admin.ts";
import { createWithTeam } from "./with-team.ts";

export async function runDailyExpiry({
  withAdmin,
  findings,
  logger,
  now = new Date(),
}: {
  withAdmin: WithAdmin;
  findings: Pick<Findings, "expireAcceptances">;
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

  let failed = 0;
  let reopened = 0;
  for (const team of teams) {
    try {
      reopened += (await findings.expireAcceptances(team, now)).length;
    } catch (error) {
      failed += 1;
      logger.error("daily expiry: a Team failed; the others still run", { team, error });
    }
  }
  logger.info("daily expiry done", {
    teamsVisited: teams.length,
    teamsFailed: failed,
    findingsReopened: reopened,
  });
  return failed > 0 ? 1 : 0;
}

/** Throws unless the admin pool's connections are the set's admin role. */
async function checkAdminRole(admin: pg.Pool, names: DatabaseRoleNames) {
  const { rows } = await admin.query<{ role: string }>("select current_user as role");
  const role = rows[0]?.role;
  if (role !== names.admin) {
    throw new Error(
      `the admin connection is ${role}, not ${names.admin}: the daily Job lists Teams only as the admin role`,
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
    user: env.WARDEN_ADMIN_USER || names.admin,
    password: env.WARDEN_ADMIN_PASSWORD || undefined,
  });
  try {
    // Both connections, and both roles, are checked before anything is read.
    await app.query("select 1");
    await checkAdminRole(admin, names);
    return await runDailyExpiry({
      withAdmin: createWithAdmin(admin),
      // No module's move rule: the Job only expires acceptances, which never reconciles a Scan.
      findings: createFindings({ withTeam: createWithTeam(app), moveRules: {} }),
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
