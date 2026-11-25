// Stops the server on SIGTERM (Cloud Run sends it before stopping an instance) or SIGINT: no new requests, then
// the pool closes and the process exits. A second signal while that runs is ignored, so nothing closes twice.
import type { Logger } from "./log.ts";

export function createShutdown(deps: {
  close: (done: () => void) => void;
  end: () => Promise<void>;
  exit: (code: number) => void;
  logger: Logger;
}): (signal: string) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) return;
    stopping = true;
    deps.logger.info("shutting down", { signal });
    deps.close(() => {
      deps.end().then(
        () => deps.exit(0),
        (error: unknown) => {
          deps.logger.error("closing the database pool failed", { error });
          deps.exit(1);
        },
      );
    });
  };
}
