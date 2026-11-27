// The Scan Job starter off Cloud Run (ADR 0009): runs scan-job.ts as a child process of the server, with the Scan's
// id and Team, the server's own PG* variables and HOME, and Node's options, so it connects as the server does, and the
// GitHub App's client id and key, which it reads repos with. Nothing else of the server's environment is handed on: no
// Clerk key, no admin password, no GitHub client secret. It isn't waited on; its exit is logged. The Judge run's
// starter runs the same child with the session's id in place of the Scan's, and the Judge's key, model and localhost
// setting (#444, #461).
import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Logger } from "./log.ts";
import {
  SCAN_ID_VARIABLE,
  SESSION_ID_VARIABLE,
  TEAM_VARIABLE,
  type JudgeJobStarter,
  type ScanJobStarter,
} from "./scans.ts";

/** The part of `child_process.spawn` the starter calls, so a test can hand it a fake. */
export type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => EventEmitter;

const SCAN_JOB = fileURLToPath(new URL("./scan-job.ts", import.meta.url));

/**
 * What the Job needs to connect and run as the server does: HOME, where `pg` finds ~/.pgpass and
 * ~/.postgresql's certificates, and Node's own options and extra CA certificates; and what it reads repos with, the
 * GitHub App's client id and private key (never its client secret, which only linking uses).
 */
const HANDED_ON = new Set([
  "HOME",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_PRIVATE_KEY",
]);

/** The server's connection variables (every PG* one libpq and `pg` read) and HANDED_ON's. */
function jobVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.startsWith("PG") || HANDED_ON.has(name)),
  );
}

/**
 * The Judge run's own variables, handed on only to it, and only when the server has them (#444): its key and model,
 * the localhost setting a Team's own model on localhost needs (slice 6a), and Langfuse's keys and URL (slice 7b).
 */
const JUDGE_VARIABLES = [
  "OPENROUTER_API_KEY",
  "WARDEN_JUDGE_MODEL",
  "WARDEN_JUDGE_LOCALHOST",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

type StarterDeps = { logger: Logger; env?: NodeJS.ProcessEnv; spawn?: Spawn };

/**
 * Spawns scan-job.ts with `childEnv`, resolving once it has started; its exit is logged with `fields` and the exit
 * code, as `exited` on 0 and `failed` otherwise.
 */
function spawnJob(
  spawn: Spawn,
  logger: Logger,
  childEnv: NodeJS.ProcessEnv,
  { fields, exited, failed }: { fields: Record<string, string>; exited: string; failed: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCAN_JOB], {
      env: childEnv,
      // Its log lines go where the server's go.
      stdio: "inherit",
    });
    child.once("spawn", () => resolve());
    child.once("error", reject);
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) logger.info(exited, { ...fields, code, signal });
      else logger.error(failed, { ...fields, code, signal });
    });
  });
}

export function localScanJobStarter({
  logger,
  env = process.env,
  spawn = nodeSpawn,
}: StarterDeps): ScanJobStarter {
  return ({ scanId, team }) =>
    spawnJob(
      spawn,
      logger,
      { ...jobVariables(env), [SCAN_ID_VARIABLE]: scanId, [TEAM_VARIABLE]: team },
      {
        fields: { scanId, team },
        exited: "scan job exited",
        failed: "scan job exited without finishing its Scan",
      },
    );
}

/**
 * The Judge run's starter (#444): the same child, with the session's id and Team in place of the Scan's, and the
 * Judge's key and model when the server has them. Its exit line holds the Team and the exit code, never the session id
 * (threat H7).
 */
export function localJudgeJobStarter({
  logger,
  env = process.env,
  spawn = nodeSpawn,
}: StarterDeps): JudgeJobStarter {
  return ({ sessionId, team }) =>
    spawnJob(
      spawn,
      logger,
      {
        ...jobVariables(env),
        ...Object.fromEntries(
          JUDGE_VARIABLES.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
        ),
        [SESSION_ID_VARIABLE]: sessionId,
        [TEAM_VARIABLE]: team,
      },
      {
        fields: { team },
        exited: "judge run exited",
        failed: "judge run exited without finishing its session",
      },
    );
}
