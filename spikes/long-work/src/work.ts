// The spike's stand-in Scan and its "work": a plain JSON value (ADR 0005) that logs a tick every 10 seconds.
// Throwaway: this branch is never merged.

export type Scan = {
  scanId: string;
  team: string;
  seconds: number;
  // Measurement 3: the Cloud Tasks handler answers 500 to the first delivery of this Scan id.
  failFirstDelivery: boolean;
  // Measurement 4: the Cloud Run Job exits 1 on its first attempt, so its retry runs the same Scan again.
  failFirstAttempt: boolean;
};

export type LogFields = Record<string, unknown> & { message: string };
export type Log = (fields: LogFields) => void;

export function parseScan(value: unknown): Scan {
  if (typeof value !== "object" || value === null) throw new Error("Scan refused: not an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.scanId !== "string" || raw.scanId === "")
    throw new Error("Scan refused: no Scan id");
  if (typeof raw.team !== "string" || raw.team === "") throw new Error("Scan refused: no Team");
  if (typeof raw.seconds !== "number" || !(raw.seconds >= 0) || raw.seconds > 3600) {
    throw new Error("Scan refused: seconds must be a number from 0 to 3600");
  }
  return {
    scanId: raw.scanId,
    team: raw.team,
    seconds: raw.seconds,
    failFirstDelivery: raw.failFirstDelivery === true,
    failFirstAttempt: raw.failFirstAttempt === true,
  };
}

// Measurement 6: what the log may say about a secret. Never its value.
export function secretReport(value: string | undefined): string {
  return value ? `secret found, length ${value.length}` : "secret missing";
}

// Measurement 3: in-memory, so the service runs with --max-instances=1.
export function createDeliveries() {
  const seen = new Set<string>();
  return {
    decide(scanId: string): 500 | 200 {
      if (seen.has(scanId)) return 200;
      seen.add(scanId);
      return 500;
    },
  };
}

// Logs "work started", a numbered tick every interval with the gap since the last one (a gap well over the
// interval means the process was paused or starved of CPU), then "work finished".
export async function runTicks(
  scan: Scan,
  options: { intervalMs: number; log: Log },
): Promise<void> {
  const { intervalMs, log } = options;
  const about = { scanId: scan.scanId, team: scan.team };
  const startedAt = Date.now();
  const endAt = startedAt + scan.seconds * 1000;
  log({ message: "work started", ...about, seconds: scan.seconds });
  let last = startedAt;
  let tick = 0;
  while (Date.now() < endAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, endAt - Date.now())));
    const now = Date.now();
    tick += 1;
    log({ message: "tick", ...about, tick, elapsedMs: now - startedAt, gapMs: now - last });
    last = now;
  }
  log({ message: "work finished", ...about, ticks: tick, elapsedMs: Date.now() - startedAt });
}
