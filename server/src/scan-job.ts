// The Scan Job (ADR 0009): runs one queued Scan. `POST /api/scans` queues the row and starts the Job with only the
// Scan's id and Team; the Job reads the rest from the row inside `withTeam`, runs the module's scanner through
// `findings.scan` under the Scan's id, and moves its state: running, then done or failed. A retried execution is
// harmless: a Scan already done changes nothing, and one whose Findings were applied reconciles again under the same id
// and start, which reconcile applies once. A rerun of an attempt that applied nothing starts afresh.
//
// A start-up file like index.ts (ADR 0005): it wires the modules' scanners and move rules from `wiring.ts`, the list
// the server shares, so the API's Rules and the Job's scanner can't drift apart.
//
// As its own process (the local starter spawns it; the Cloud Run Job runs it from slice 1b):
// - WARDEN_SCAN_ID and WARDEN_TEAM name the Scan; either missing or blank exits 1 before connecting.
// - The pool is the PG* variables', as the app role, with the server's role check on connect: a role that can get
//   around row-level security exits 1, naming the role and why.
// - GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY give Guard its RepoReader; one without the other, or a key that
//   isn't RSA, exits 1 before connecting, naming the variables. Neither set, a Guard Scan fails.
// - It needs no Clerk variable, no admin password and no GitHub client secret. Exit 0 when the Scan is done; 1
//   otherwise.
import { ConfigError, gitHubReaderSettings, type GitHubReaderSettings } from "./config.ts";
import { createPool, guardDatabaseRole } from "./database.ts";
import { createFindings, type Findings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import {
  createScans,
  SCAN_ID_VARIABLE,
  TEAM_VARIABLE,
  type Scanners,
  type Scans,
} from "./scans.ts";
import { gitHubRepoReader, MOVE_RULES, scanners } from "./wiring.ts";
import { createWithTeam } from "./with-team.ts";

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

  // `move` keeps the start reconcile already applied this Scan's id under, so a retry reconciles under the same pair;
  // otherwise it starts afresh. Nothing moved means the Scan has ended: another attempt finished it after this one read
  // it, or the running limit ended it, which is final.
  const running = await scans.move(team, scanId, "running");
  if (running === undefined) {
    logger.info(
      "scan job: the Scan was finished by another attempt or ended by the running limit; nothing changed",
      {
        scanId,
        team,
      },
    );
    return 0;
  }

  // From here every exit ends the Scan: done, failed, or left running for the retry to finish.
  let outcome: Awaited<ReturnType<Findings["scan"]>>;
  let dropped = 0;
  try {
    const startedAt = running.started_at;
    if (startedAt === null) throw new Error("the Scan has no start after moving to running");
    // Story 15: the start checked the Assets when it was queued; the Team may have dropped one since. The Scan covers
    // only those it still holds, so a dropped one is never read and its Findings stay as they are.
    const held = scanner.held ? await scanner.held(team, assets) : assets;
    dropped = assets.length - held.length;
    if (held.length === 0) {
      throw new Error(`the Team holds none of the Scan's Assets (${dropped} dropped)`);
    }
    outcome = await findings.scan(
      { id: scanId, started_at: startedAt, team, module, assets: held, rules },
      (recorder) => scanner.scan({ team, assets: held, rules }, recorder),
    );
  } catch (error) {
    // findings.scan reconciles nothing when the scanner throws or a report is refused. The message stays in the log,
    // logged before the move so a failed move can't hide it.
    logger.error("scan job: the Scan failed; nothing was reconciled", {
      scanId,
      team,
      module,
      dropped,
      error,
    });
    try {
      await scans.move(team, scanId, "failed");
    } catch (moveError) {
      logger.error("scan job: the Scan couldn't be marked failed; it stays running", {
        scanId,
        team,
        error: moveError,
      });
    }
    return 1;
  }

  try {
    await scans.move(team, scanId, "done");
  } catch (error) {
    // The Findings are applied; a retry reconciles under the same id and start, changing nothing, then marks it done.
    logger.error("scan job: the Scan reconciled but couldn't be marked done; it stays running", {
      scanId,
      team,
      module,
      error,
    });
    return 1;
  }
  logger.info("scan job done", {
    scanId,
    team,
    module,
    dropped,
    opened: outcome.opened.length,
    fixed: outcome.fixed.length,
    reopened: outcome.reopened.length,
  });
  return 0;
}

/** The environment variable's value, or undefined when it's missing or blank. */
const named = (value: string | undefined) => (value?.trim() ? value : undefined);

async function main(env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  const scanId = named(env[SCAN_ID_VARIABLE]);
  const team = named(env[TEAM_VARIABLE]);
  if (scanId === undefined || team === undefined) {
    const missing = [scanId ? [] : [SCAN_ID_VARIABLE], team ? [] : [TEAM_VARIABLE]].flat();
    logger.error(`scan job failed before connecting: set ${missing.join(" and ")}`, {
      variables: missing,
    });
    return 1;
  }
  let github: GitHubReaderSettings | undefined;
  try {
    github = gitHubReaderSettings(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger.error(`scan job failed before connecting: ${error.message}`, {
      variables: error.variables,
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
      // ADR 0005: the modules come in here, as in index.ts. Without GitHub's settings there's no RepoReader, so a
      // Guard Scan fails.
      findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
      scanners: scanners({
        withTeam,
        reader: github && gitHubRepoReader(github, logger),
        logger,
      }),
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
