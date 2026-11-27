// The URL rule for a Team's own Judge model (spec #225, slice 6a; owner, 2026-11-27, Q5). An Admin may name an
// OpenAI-compatible base URL only when it is https and every address its host resolves to is public, so the server
// can't be pointed at its own network or the metadata server. With the server's localhost setting on (local
// development), `localhost`, `127.0.0.1` and `[::1]` may also be named, over http or https, and may resolve to a
// loopback address and nothing else. A reason never names the URL or its host.
import { promises as dns } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";

/** Resolves a host to every address it has, as `dns.promises.lookup` with `{ all: true }` does. */
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export const resolveHost: Resolve = (host) => dns.lookup(host, { all: true });

/** The hosts the server's localhost setting lets an Admin name, as a URL's `hostname` holds them. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The longest URL an Admin may name. */
export const MAX_JUDGE_URL_LENGTH = 2048;

/** The connection to a Team's model was refused before it opened: `message` is the reason. */
export class AddressRefused extends Error {
  override name = "AddressRefused";
}

/**
 * The URL rule's inputs: the server's localhost setting (WARDEN_JUDGE_LOCALHOST), and how a host is looked up (a
 * test's stub; DNS otherwise).
 */
export type UrlRule = { allowLocalhost: boolean; resolve?: Resolve };

/** IPv4 ranges that aren't public, each with the kind a reason names, its article with it. */
const IPV4_REFUSED: [base: string, bits: number, kind: string][] = [
  ["0.0.0.0", 8, "an unspecified"],
  ["10.0.0.0", 8, "a private"],
  ["100.64.0.0", 10, "a shared"],
  ["127.0.0.0", 8, "a loopback"],
  ["169.254.0.0", 16, "a link-local"],
  ["172.16.0.0", 12, "a private"],
  ["192.0.0.0", 24, "a reserved"],
  ["192.0.2.0", 24, "a documentation"],
  ["192.168.0.0", 16, "a private"],
  ["198.18.0.0", 15, "a benchmarking"],
  ["198.51.100.0", 24, "a documentation"],
  ["203.0.113.0", 24, "a documentation"],
  ["224.0.0.0", 4, "a multicast"],
  ["240.0.0.0", 4, "a reserved"],
];

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function ipv4Kind(address: string): string | undefined {
  const value = ipv4Number(address);
  for (const [base, bits, kind] of IPV4_REFUSED) {
    const size = 2 ** (32 - bits);
    if (Math.floor(value / size) === Math.floor(ipv4Number(base) / size)) return kind;
  }
  return undefined;
}

/** An IPv6 address's eight 16-bit groups, with `::` expanded and a dotted IPv4 tail read as its two groups. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail !== undefined) {
    const value = ipv4Number(tail);
    text = `${text.slice(0, -tail.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const part = (side: string) =>
    side === "" ? [] : side.split(":").map((group) => parseInt(group, 16));
  if (rest === undefined) return part(head);
  const front = part(head);
  const back = part(rest);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function ipv6Kind(address: string): string | undefined {
  const groups = ipv6Groups(address);
  const embedded = () =>
    `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  const zeroTo = (end: number) => groups.slice(0, end).every((group) => group === 0);
  const [first, second, third] = groups as [number, number, number];
  if (zeroTo(8)) return "an unspecified";
  if (zeroTo(7) && groups[7] === 1) return "a loopback";
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) carry an IPv4 address: its kind.
  if (zeroTo(5) && groups[5] === 0xffff) return ipv4Kind(embedded());
  if (zeroTo(6)) return ipv4Kind(embedded());
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return ipv4Kind(embedded());
  }
  if (first === 0x64 && second === 0xff9b && third === 1) return "a local-use NAT64";
  if (first === 0x100 && groups.slice(1, 4).every((group) => group === 0)) return "a discard-only";
  if (first === 0x2001 && second === 0xdb8) return "a documentation";
  if (first === 0x2002) return "a 6to4";
  if ((first & 0xfe00) === 0xfc00) return "a unique local";
  if ((first & 0xffc0) === 0xfe80) return "a link-local";
  if ((first & 0xffc0) === 0xfec0) return "a site-local";
  if ((first & 0xff00) === 0xff00) return "a multicast";
  return undefined;
}

/** The kind of address that isn't public (a loopback, a private, …), undefined for a public one. */
function addressKind(address: string): string | undefined {
  if (isIPv4(address)) return ipv4Kind(address);
  if (isIPv6(address)) return ipv6Kind(address);
  return "an unreadable";
}

/** Whether `address` is an IP address on the public internet: not loopback, private, link-local and the rest. */
export function isPublicAddress(address: string): boolean {
  return addressKind(address) === undefined;
}

/**
 * Why a connection to `address` is refused, or undefined when it may open. A local host (one of `LOCAL_HOSTS`, with
 * the server's localhost setting on) may connect to a loopback address; any other host only to a public one.
 */
function addressRefusal(address: string, local: boolean): string | undefined {
  const kind = addressKind(address);
  if (kind === undefined || (local && kind === "a loopback")) return undefined;
  return `its host is ${kind} address`;
}

/** A URL's host as an address, without IPv6's brackets, when it is one; undefined for a name. */
function literalAddress(hostname: string): string | undefined {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare) ? bare : undefined;
}

/** An address a host resolved to, as `Resolve` answers it. */
export type ResolvedAddress = Awaited<ReturnType<Resolve>>[number];

export type CheckedTarget =
  { ok: true; addresses: ResolvedAddress[] } | { ok: false; reason: string };

/**
 * The URL rule's check of a URL's scheme and host, made when a URL is set and again by the pinned connection at each
 * call: the scheme is https, or http on a local host; and every address the host resolves to through `resolve` (or
 * the address in the URL itself) may be connected to. The addresses it checked, or why it's refused.
 */
export async function checkTarget(
  url: URL,
  { allowLocalhost, resolve = resolveHost }: UrlRule,
): Promise<CheckedTarget> {
  const refuse = (reason: string): CheckedTarget => ({ ok: false, reason });
  const local = allowLocalhost && LOCAL_HOSTS.has(url.hostname);
  if (!(url.protocol === "https:" || (local && url.protocol === "http:"))) {
    return refuse("its scheme isn't https");
  }
  const literal = literalAddress(url.hostname);
  let addresses: ResolvedAddress[];
  if (literal !== undefined) {
    addresses = [{ address: literal, family: isIPv4(literal) ? 4 : 6 }];
  } else {
    try {
      addresses = await resolve(url.hostname);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) return refuse("its host doesn't resolve");
  }
  for (const { address } of addresses) {
    const reason = addressRefusal(address, local);
    if (reason !== undefined) return refuse(reason);
  }
  return { ok: true, addresses };
}

export type CheckedUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Checks a Team's model URL against the URL rule: the URL to store (without a trailing slash, as the Judge adds
 * `/chat/completions`), or why it's refused.
 */
export async function checkJudgeUrl(url: string, rule: UrlRule): Promise<CheckedUrl> {
  const refuse = (reason: string): CheckedUrl => ({ ok: false, reason });
  if (url.length > MAX_JUDGE_URL_LENGTH) {
    return refuse(`it's over ${MAX_JUDGE_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse("it isn't a URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return refuse("it holds a user name or password");
  }
  if (parsed.search !== "" || url.includes("?")) return refuse("it holds a query");
  if (parsed.hash !== "" || url.includes("#")) return refuse("it holds a fragment");
  const target = await checkTarget(parsed, rule);
  if (!target.ok) return target;
  return { ok: true, url: parsed.href.replace(/\/+$/, "") };
}
