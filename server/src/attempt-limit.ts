// A fixed-window limit on attempts per key: `max` attempts let through in a window that begins at a key's first attempt,
// then the key is held back for the rest of it. Each key is counted exactly as given. The count lives in this server
// instance's memory, so each Cloud Run instance keeps its own (threat A5 accepts this).
import { setNewest } from "./capped-map.ts";

export type AttemptLimit = {
  /**
   * Counts an attempt under `key` before its outcome is known, so attempts sent at once count too; or, when the key is
   * held back, the whole seconds until it may try again, and nothing is counted.
   */
  attempt(key: string): number | undefined;
  /** Takes back an attempt under `key` that shouldn't count. */
  takeBack(key: string): void;
  /** How many keys are held in memory; for tests. */
  size(): number;
};

export function createAttemptLimit(options: {
  /** Attempts let through per window; the next is held back. */
  max: number;
  windowMs: number;
  now?: () => number;
  /** The most keys kept; past it, the one whose window began first is forgotten. */
  maxKeys?: number;
}): AttemptLimit {
  const { max, windowMs, now = Date.now, maxKeys = 100_000 } = options;
  /** Per key: when its window began (its first attempt in it), and its attempts since. Kept in the order windows
   * began, so the first entry is the oldest. */
  const windows = new Map<string, { start: number; attempts: number }>();
  let lastSweep = now();

  const current = (key: string, at: number) => {
    const window = windows.get(key);
    if (window === undefined || at - window.start >= windowMs) return undefined;
    return window;
  };

  /** Forgets every window that's over; at most once per window length, so it costs little however busy. */
  const sweep = (at: number) => {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [key, window] of windows) {
      if (at - window.start >= windowMs) windows.delete(key);
    }
  };

  return {
    attempt(key) {
      const at = now();
      sweep(at);
      const window = current(key, at);
      if (window !== undefined) {
        if (window.attempts >= max) return Math.ceil((window.start + windowMs - at) / 1000);
        window.attempts++;
        return undefined;
      }
      setNewest(windows, key, { start: at, attempts: 1 }, maxKeys);
      return undefined;
    },
    takeBack(key) {
      const window = current(key, now());
      if (window !== undefined && window.attempts > 0) window.attempts--;
    },
    size: () => windows.size,
  };
}
