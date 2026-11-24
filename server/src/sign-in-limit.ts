// The limit on failed sign-ins (threat A5): an address whose session tokens fail 20 times inside one minute is held
// back for the rest of that minute, before its token is checked. The count lives in this server instance's memory,
// so each Cloud Run instance keeps its own: an accepted limit (docs/threat-model.md). Clerk's own sign-in protection
// covers the password step itself.

export type SignInLimit = {
  /** Whole seconds until `address` may try again, or undefined when it may now. */
  retryAfter(address: string): number | undefined;
  /** Counts one failed sign-in against `address`. */
  failed(address: string): void;
  /** How many addresses are held in memory; for tests. */
  size(): number;
};

export function createSignInLimit(
  options: {
    /** Failures let through per window; the next request is held back. */
    max?: number;
    windowMs?: number;
    now?: () => number;
    /** Above this many addresses, a failure first forgets every address whose window is over. */
    sweepAbove?: number;
  } = {},
): SignInLimit {
  const { max = 20, windowMs = 60_000, now = Date.now, sweepAbove = 10_000 } = options;
  /** Per address: when its window began (its first failure in it), and its failures since. */
  const windows = new Map<string, { start: number; failures: number }>();

  const current = (address: string, at: number) => {
    const window = windows.get(address);
    if (window === undefined || at - window.start >= windowMs) return undefined;
    return window;
  };

  return {
    retryAfter(address) {
      const at = now();
      const window = current(address, at);
      if (window === undefined || window.failures < max) return undefined;
      return Math.ceil((window.start + windowMs - at) / 1000);
    },
    failed(address) {
      const at = now();
      if (windows.size > sweepAbove) {
        for (const [seen, window] of windows) {
          if (at - window.start >= windowMs) windows.delete(seen);
        }
      }
      const window = current(address, at);
      if (window === undefined) windows.set(address, { start: at, failures: 1 });
      else window.failures++;
    },
    size: () => windows.size,
  };
}

/**
 * The client's address, which the sign-in limit counts against. On Cloud Run, Google's front end appends the address
 * it saw to X-Forwarded-For, after anything the client sent, so only the last entry can be trusted; the socket is
 * Google's. Elsewhere (locally) there's no proxy, so the socket's address, and X-Forwarded-For is the client's own
 * text. "unknown" when neither is there: such requests share one count.
 */
export function clientAddress(
  request: { forwardedFor: string | undefined; socketAddress: string | undefined },
  behindCloudRun: boolean,
): string {
  const address = behindCloudRun
    ? request.forwardedFor?.split(",").at(-1)?.trim()
    : request.socketAddress;
  return address === undefined || address === "" ? "unknown" : address;
}
