// The limit on failed sign-ins (threat A5): an address whose session tokens fail 20 times inside one minute is held
// back for the rest of that minute, before its token is checked. The count lives in this server instance's memory,
// so each Cloud Run instance keeps its own: an accepted limit (docs/threat-model.md). Clerk's own sign-in protection
// covers the password step itself. The hook endpoint keeps one of its own for refused hook tokens (threat H1).
import { createAttemptLimit } from "./attempt-limit.ts";

/** What `check` found: the address held back, with seconds to wait; the token missing or bad; or what it names. */
export type TokenCheck<T> = { heldFor: number } | { refused: true } | { found: T };

export type SignInLimit = {
  /**
   * Checks the bearer token in `authorization` with `verify`, against this limit: held back before the token is read
   * when `address` has failed too often; otherwise counted before the check, so tokens sent at once count too, and
   * taken back unless the token was missing or bad. `verify` throwing takes the attempt back too, and throws on.
   */
  check<T>(
    address: string,
    authorization: string | undefined,
    verify: (token: string) => Promise<T | null | undefined>,
  ): Promise<TokenCheck<T>>;
  /**
   * Counts an attempt from `address` before its token is checked, so attempts sent at once count too; or, when the
   * address is held back, the whole seconds until it may try again, and nothing is counted.
   */
  attempt(address: string): number | undefined;
  /** Takes back an attempt whose token turned out good (or couldn't be checked): only failures count. */
  takeBack(address: string): void;
  /** How many addresses are held in memory; for tests. */
  size(): number;
};

export function createSignInLimit(
  options: {
    /** Failed attempts let through per window; the next is held back. */
    max?: number;
    windowMs?: number;
    now?: () => number;
    /** The most addresses kept; past it, the one whose window began first is forgotten. */
    maxAddresses?: number;
  } = {},
): SignInLimit {
  const { max = 20, windowMs = 60_000, now = Date.now, maxAddresses = 100_000 } = options;
  // Counted under each address's key, so an IPv6 /64 is one address.
  const limit = createAttemptLimit({ max, windowMs, now, maxKeys: maxAddresses });
  const attempt = (address: string) => limit.attempt(limitKey(address));
  const takeBack = (address: string) => limit.takeBack(limitKey(address));
  return {
    async check(address, authorization, verify) {
      const heldFor = attempt(address);
      if (heldFor !== undefined) return { heldFor };
      const token = bearerToken(authorization);
      let found;
      try {
        found = token === undefined ? undefined : await verify(token);
      } catch (thrown) {
        // The token couldn't be checked, so it wasn't found bad.
        takeBack(address);
        throw thrown;
      }
      if (found === undefined || found === null) return { refused: true };
      takeBack(address);
      return { found };
    },
    attempt,
    takeBack,
    size: limit.size,
  };
}

/**
 * The token an `Authorization` header carries, or undefined when it isn't one `Bearer` token. An auth scheme's name is
 * case-insensitive (RFC 9110, 11.1): `bearer` and `BEARER` are `Bearer`.
 */
function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
}

/**
 * What the limit counts an address under. An IPv6 address counts by its /64, the block one subscriber is usually
 * given, so one client can't step past the limit by changing its last 64 bits; an IPv4 address mapped into IPv6 counts
 * as the IPv4 address. Anything else counts as it is.
 */
export function limitKey(address: string): string {
  const plain = address.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain)?.[1];
  if (mapped !== undefined) return mapped;
  if (!plain.includes(":")) return plain;
  const [head = "", tail] = plain.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? 0 : Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array<string>(zeros).fill("0"), ...tailGroups];
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

/**
 * The client's address, which the sign-in limit counts against.
 *
 * On Cloud Run, Google's front end appends the address it saw to X-Forwarded-For, after anything the client sent, and
 * the socket's peer is Google's. This takes the **last** entry as the client: true for a service reached at its own
 * run.app URL, as Warden is. Google's docs don't say so for Cloud Run itself; the first owner preview (#65) checks
 * it, comparing the clientAddress on a refused sign-in's request log line with Cloud Run's httpRequest.remoteIp. **A
 * load balancer in front would change this:** it appends the client and then its own address, so the client would be
 * the second-to-last entry, and this would count every request under the load balancer's address (threat A5).
 *
 * Elsewhere (locally) there's no proxy, so the socket's address, and X-Forwarded-For is the client's own text.
 * "unknown" when neither is there: such requests share one count.
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
