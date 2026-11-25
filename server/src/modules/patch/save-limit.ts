// The limit on Product saves (the spec's secure default for a public URL): each save runs a Patch Scan, so a Team may
// save (POST, PUT and DELETE together) 30 times a minute, and the next is held back for the rest of that minute. The
// count lives in this server instance's memory, as the sign-in limit's does, so each Cloud Run instance keeps its own:
// an accepted limit. A Lead editing by hand stays well under it.

export type SaveLimit = {
  /** Counts a save by `team`; or, when the Team is held back, the whole seconds until it may save again, and nothing
   * is counted. */
  attempt(team: string): number | undefined;
  /** How many Teams are held in memory; for tests. */
  size(): number;
};

export function createSaveLimit(
  options: {
    /** Saves let through per window; the next is held back. */
    max?: number;
    windowMs?: number;
    now?: () => number;
  } = {},
): SaveLimit {
  const { max = 30, windowMs = 60_000, now = Date.now } = options;
  /** Per Team id, as Clerk gives it (case counts): when its window began (its first save in it), and its saves since. */
  const windows = new Map<string, { start: number; saves: number }>();
  let lastSweep = now();

  /** Forgets every window that's over; at most once per window length, so it costs little however busy. */
  const sweep = (at: number) => {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [team, window] of windows) {
      if (at - window.start >= windowMs) windows.delete(team);
    }
  };

  return {
    attempt(team) {
      const at = now();
      sweep(at);
      const window = windows.get(team);
      if (window === undefined || at - window.start >= windowMs) {
        windows.set(team, { start: at, saves: 1 });
        return undefined;
      }
      if (window.saves >= max) return Math.ceil((window.start + windowMs - at) / 1000);
      window.saves++;
      return undefined;
    },
    size: () => windows.size,
  };
}
