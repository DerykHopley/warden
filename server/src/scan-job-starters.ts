// Picks the Scan Job starter the server wires (ADR 0009). A named Cloud Run Job always wins, on Cloud Run or off it.
// Without one, off Cloud Run the Job runs as a child process; on Cloud Run (an owner preview) none is wired, so a start
// answers 503 there.
import { cloudRunScanJobStarter, type Fetch } from "./cloud-run-scan-job-starter.ts";
import type { Config } from "./config.ts";
import { localScanJobStarter, type Spawn } from "./local-scan-job-starter.ts";
import type { Logger } from "./log.ts";
import type { ScanJobStarter } from "./scans.ts";

export function scanJobStarterFor(
  config: Pick<Config, "scanJob" | "behindCloudRun">,
  { logger, fetch, spawn }: { logger: Logger; fetch?: Fetch; spawn?: Spawn },
): ScanJobStarter | undefined {
  if (config.scanJob !== undefined) {
    return cloudRunScanJobStarter({ job: config.scanJob, logger, fetch });
  }
  if (config.behindCloudRun) return undefined;
  return localScanJobStarter({ logger, spawn });
}
