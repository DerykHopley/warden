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

/** IPv4 ranges that aren't public, each with the kind a reason names. */
const IPV4_REFUSED: [base: string, bits: number, kind: string][] = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.168.0.0", 16, "private"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
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
  if (zeroTo(8)) return "unspecified";
  if (zeroTo(7) && groups[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) carry an IPv4 address: its kind.
  if (zeroTo(5) && groups[5] === 0xffff) return ipv4Kind(embedded());
  if (zeroTo(6)) return ipv4Kind(embedded());
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return ipv4Kind(embedded());
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return "unique local";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xffc0) === 0xfec0) return "site-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  return undefined;
}

/** The kind of address that isn't public (loopback, private, link-local, …), undefined for a public one. */
function addressKind(address: string): string | undefined {
  if (isIPv4(address)) return ipv4Kind(address);
  if (isIPv6(address)) return ipv6Kind(address);
  return "unreadable";
}

/** Whether `address` is an IP address on the public internet: not loopback, private, link-local and the rest. */
export function isPublicAddress(address: string): boolean {
  return addressKind(address) === undefined;
}

/**
 * Why a connection to `address` is refused, or undefined when it may open. A local host (one of `LOCAL_HOSTS`, with
 * the server's localhost setting on) may connect to a loopback address; any other host only to a public one.
 */
export function addressRefusal(address: string, local: boolean): string | undefined {
  const kind = addressKind(address);
  if (kind === undefined || (local && kind === "loopback")) return undefined;
  return `its host is a${/^[aeiou]/.test(kind) ? "n" : ""} ${kind} address`;
}

/** Whether `hostname`, as a URL holds it, is a local host the server's localhost setting `allowLocalhost` lets in. */
export function isLocalHost(hostname: string, allowLocalhost: boolean): boolean {
  return allowLocalhost && LOCAL_HOSTS.has(hostname);
}

/** A URL's host as an address, without IPv6's brackets, when it is one; undefined for a name. */
export function literalAddress(hostname: string): string | undefined {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare) ? bare : undefined;
}

export type CheckedUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Checks a Team's model URL against the URL rule, resolving its host through `resolve`: the URL to store (without a
 * trailing slash, as the Judge adds `/chat/completions`), or why it's refused.
 */
export async function checkJudgeUrl(
  url: string,
  { allowLocalhost, resolve = resolveHost }: { allowLocalhost: boolean; resolve?: Resolve },
): Promise<CheckedUrl> {
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
  const local = isLocalHost(parsed.hostname, allowLocalhost);
  if (!(parsed.protocol === "https:" || (local && parsed.protocol === "http:"))) {
    return refuse("its scheme isn't https");
  }

  const literal = literalAddress(parsed.hostname);
  let addresses: string[];
  if (literal !== undefined) {
    addresses = [literal];
  } else {
    try {
      addresses = (await resolve(parsed.hostname)).map((answer) => answer.address);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) return refuse("its host doesn't resolve");
  }
  for (const address of addresses) {
    const reason = addressRefusal(address, local);
    if (reason !== undefined) return refuse(reason);
  }
  return { ok: true, url: parsed.href.replace(/\/+$/, "") };
}
