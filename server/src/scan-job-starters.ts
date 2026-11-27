// Picks the Scan Job starter, and the Judge run's starter, the server wires (ADR 0009). A named Cloud Run Job always
// wins, on Cloud Run or off it. Without one, off Cloud Run the Job runs as a child process; on Cloud Run (an owner
// preview) none is wired, so a Scan's start answers 503 there and a SessionEnd starts no Judge run.
import { cloudRunJudgeJobStarter, cloudRunScanJobStarter } from "./cloud-run-scan-job-starter.ts";
import type { Config } from "./config.ts";
import type { Fetch } from "./http-call.ts";
import { localJudgeJobStarter, localScanJobStarter, type Spawn } from "./local-scan-job-starter.ts";
import type { Logger } from "./log.ts";
import type { JudgeJobStarter, ScanJobStarter } from "./scans.ts";

/** The config the choice reads: the named Cloud Run Job, if any, and whether the server runs on Cloud Run. */
type StarterConfig = Pick<Config, "scanJob" | "behindCloudRun">;
/** What either starter is built with: its logger, and the fetch or spawn it calls. */
type StarterDeps = { logger: Logger; fetch?: Fetch; spawn?: Spawn };

/** The one choice both starters make, given the Cloud Run and the local factory. */
function starterFor<Starter>(
  config: StarterConfig,
  { logger, fetch, spawn }: StarterDeps,
  factories: {
    cloudRun: (deps: { job: string; logger: Logger; fetch?: Fetch }) => Starter;
    local: (deps: { logger: Logger; spawn?: Spawn }) => Starter;
  },
): Starter | undefined {
  if (config.scanJob !== undefined) {
    return factories.cloudRun({ job: config.scanJob, logger, fetch });
  }
  if (config.behindCloudRun) return undefined;
  return factories.local({ logger, spawn });
}

export function scanJobStarterFor(
  config: StarterConfig,
  deps: StarterDeps,
): ScanJobStarter | undefined {
  return starterFor(config, deps, {
    cloudRun: cloudRunScanJobStarter,
    local: localScanJobStarter,
  });
}

/** The Judge run's starter (#444), chosen as `scanJobStarterFor` chooses, from the same config. */
export function judgeJobStarterFor(
  config: StarterConfig,
  deps: StarterDeps,
): JudgeJobStarter | undefined {
  return starterFor(config, deps, {
    cloudRun: cloudRunJudgeJobStarter,
    local: localJudgeJobStarter,
  });
}
