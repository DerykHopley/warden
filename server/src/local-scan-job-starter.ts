// The Scan Job starter off Cloud Run (ADR 0009): runs scan-job.ts as a child process of the server, with the Scan's
// id and Team, the server's own PG* variables and HOME, and Node's options, so it connects as the server does. Nothing
// else of the server's environment is handed on: no Clerk key, no admin password. It isn't waited on; its exit is
// logged.
import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Logger } from "./log.ts";
import { SCAN_ID_VARIABLE, TEAM_VARIABLE, type ScanJobStarter } from "./scans.ts";

/** The part of `child_process.spawn` the starter calls, so a test can hand it a fake. */
export type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => EventEmitter;

const SCAN_JOB = fileURLToPath(new URL("./scan-job.ts", import.meta.url));

/**
 * What the Job needs to connect and run as the server does: HOME, where `pg` finds ~/.pgpass and
 * ~/.postgresql's certificates, and Node's own options and extra CA certificates.
 */
const HANDED_ON = new Set(["HOME", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]);

/** The server's connection variables (every PG* one libpq and `pg` read) and HANDED_ON's. */
function jobVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.startsWith("PG") || HANDED_ON.has(name)),
  );
}

export function localScanJobStarter({
  logger,
  env = process.env,
  spawn = nodeSpawn,
}: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
}): ScanJobStarter {
  return ({ scanId, team }) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCAN_JOB], {
        env: { ...jobVariables(env), [SCAN_ID_VARIABLE]: scanId, [TEAM_VARIABLE]: team },
        // Its log lines go where the server's go.
        stdio: "inherit",
      });
      child.once("spawn", () => resolve());
      child.once("error", reject);
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        const fields = { scanId, team, code, signal };
        if (code === 0) logger.info("scan job exited", fields);
        else logger.error("scan job exited without finishing its Scan", fields);
      });
    });
}
