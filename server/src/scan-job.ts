// The Scan Job (ADR 0009): runs one queued Scan. `POST /api/scans` queues the row and starts the Job with only the
// Scan's id and Team; the Job reads the rest from the row inside `withTeam`, runs the module's scanner through
// `findings.scan` under the Scan's id, and moves its state: running, then done or failed. A retried execution is
// harmless: a Scan already done changes nothing, and one run again reconciles under the same id and start, which
// reconcile applies once.
//
// A start-up file like index.ts (ADR 0005): the one other file that may import the modules, to wire their scanners.
// None is wired in this slice; Guard's comes with its scanner.
//
// As its own process (the local starter spawns it; the Cloud Run Job runs it from slice 1b):
// - WARDEN_SCAN_ID and WARDEN_TEAM name the Scan; either missing or blank exits 1 before connecting.
// - The pool is the PG* variables', as the app role, with the server's role check on connect: a role that can get
//   around row-level security exits 1, naming the role and why.
// - It needs no Clerk variable and no admin password. Exit 0 when the Scan is done; 1 otherwise.
import { createPool, guardDatabaseRole } from "./database.ts";
import { createFindings, type Findings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import { createScans, type Scanners, type Scans } from "./scans.ts";
import { createWithTeam } from "./with-team.ts";

/** Each module's scanner, as the Job wires them: none yet. */
export const SCANNERS: Scanners = {};

export async function runScanJob({
  scanId,
  team,
  scans,
  findings,
  scanners,
  logger,
}: {
  scanId: string;
  team: string;
  scans: Scans;
  findings: Pick<Findings, "scan">;
  scanners: Scanners;
  logger: Logger;
}): Promise<0 | 1> {
  const scan = await scans.get(team, scanId);
  if (scan === undefined) {
    logger.error("scan job: no such Scan in this Team; nothing changed", { scanId, team });
    return 1;
  }
  if (scan.state === "done") {
    logger.info("scan job: the Scan is already done; nothing changed", { scanId, team });
    return 0;
  }
  const { module, assets, rules } = scan;
  const scanner = scanners[module];
  if (scanner === undefined) {
    logger.error("scan job: the Scan's module has no scanner here; nothing changed", {
      scanId,
      team,
      module,
    });
    return 1;
  }

  // `move` sets the start on the first run and keeps it on a retry, so a retry reconciles under the same pair.
  const startedAt = (await scans.move(team, scanId, "running"))?.started_at;
  if (!startedAt) throw new Error(`scan job: Scan ${scanId} has no start after moving to running`);
  try {
    const outcome = await findings.scan(
      { id: scanId, started_at: startedAt, team, module, assets, rules },
      (recorder) => scanner.scan({ team, assets, rules }, recorder),
    );
    await scans.move(team, scanId, "done");
    logger.info("scan job done", {
      scanId,
      team,
      module,
      opened: outcome.opened.length,
      fixed: outcome.fixed.length,
      reopened: outcome.reopened.length,
    });
    return 0;
  } catch (error) {
    // findings.scan reconciles nothing when the scanner throws or a report is refused. The message stays in the log.
    await scans.move(team, scanId, "failed");
    logger.error("scan job: the Scan failed; nothing was reconciled", {
      scanId,
      team,
      module,
      error,
    });
    return 1;
  }
}

/** The environment variable's value, or undefined when it's missing or blank. */
const named = (value: string | undefined) => (value?.trim() ? value : undefined);

async function main(env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  const scanId = named(env.WARDEN_SCAN_ID);
  const team = named(env.WARDEN_TEAM);
  if (scanId === undefined || team === undefined) {
    const missing = [scanId ? [] : ["WARDEN_SCAN_ID"], team ? [] : ["WARDEN_TEAM"]].flat();
    logger.error(`scan job failed before connecting: set ${missing.join(" and ")}`, {
      variables: missing,
    });
    return 1;
  }
  const pool = createPool(logger, {
    max: 2,
    onConnect: guardDatabaseRole(({ role, reason }) => {
      logger.error(`scan job: its database role can bypass row-level security. ${reason}.`, {
        role,
        reason,
      });
    }),
  });
  try {
    await pool.query("select 1");
    const withTeam = createWithTeam(pool);
    return await runScanJob({
      scanId,
      team,
      scans: createScans({ withTeam }),
      // ADR 0005: the modules come in here, as in index.ts.
      findings: createFindings({
        withTeam,
        moveRules: { guard: guardMoveRule, patch: patchMoveRule },
      }),
      scanners: SCANNERS,
      logger,
    });
  } catch (error) {
    logger.error("scan job failed", { scanId, team, error });
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.env, createLogger());
}
