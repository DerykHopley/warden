// Picks the Scan Job starter, and the Judge run's starter, the server wires (ADR 0009). A named Cloud Run Job always
// wins, on Cloud Run or off it. Without one, off Cloud Run the Job runs as a child process; on Cloud Run (an owner
// preview) none is wired, so a Scan's start answers 503 there and a SessionEnd starts no Judge run.
import { cloudRunJudgeJobStarter, cloudRunScanJobStarter } from "./cloud-run-scan-job-starter.ts";
import type { Config } from "./config.ts";
import type { Fetch } from "./http-call.ts";
import { localJudgeJobStarter, localScanJobStarter, type Spawn } from "./local-scan-job-starter.ts";
import type { Logger } from "./log.ts";
import type { JudgeJobStarter, ScanJobStarter } from "./scans.ts";

type Choice = Pick<Config, "scanJob" | "behindCloudRun">;
type Deps = { logger: Logger; fetch?: Fetch; spawn?: Spawn };

export function scanJobStarterFor(
  config: Choice,
  { logger, fetch, spawn }: Deps,
): ScanJobStarter | undefined {
  if (config.scanJob !== undefined) {
    return cloudRunScanJobStarter({ job: config.scanJob, logger, fetch });
  }
  if (config.behindCloudRun) return undefined;
  return localScanJobStarter({ logger, spawn });
}

/** The Judge run's starter (#444), chosen as `scanJobStarterFor` chooses, from the same config. */
export function judgeJobStarterFor(
  config: Choice,
  { logger, fetch, spawn }: Deps,
): JudgeJobStarter | undefined {
  if (config.scanJob !== undefined) {
    return cloudRunJudgeJobStarter({ job: config.scanJob, logger, fetch });
  }
  if (config.behindCloudRun) return undefined;
  return localJudgeJobStarter({ logger, spawn });
}
