/**
 * Patch's verdict (A15): does a CVE touch this version of a product, which version fixes it, and who acts. Pure
 * functions, ported from Patch's backend/app/verdict.py through the spike (architecture/spikes/stack-ts/patch-p3 in
 * the capstone archive), keeping its names and behaviour.
 *
 * Versions compare by each ecosystem's own rules: PEP 440 for PyPI (@renovatebot/pep440), SemVer 2.0 for npm and Go
 * modules (semver; Go versions carry a leading "v"). Where JavaScript differs from Python, the spike's NOTES.md
 * mismatches are kept: padSemver, the one trailing "\n" checkVersion accepts, and max()'s tie-breaking.
 */
import * as pep440 from "@renovatebot/pep440";
import type { Coverage, Usage } from "@warden/contracts";
import semver from "semver";
import type { SemVer } from "semver";
import { VersionRefused } from "./errors.ts";

export const USAGE_LABELS: Record<Usage, string> = {
  self_hosted: "self-hosted app",
  library: "library",
  transitive: "comes in through another package",
  hosted: "hosted service",
};
export type WhoActs = "you" | "upstream" | "vendor";
export const WHO_ACTS: Record<Usage, WhoActs> = {
  self_hosted: "you",
  library: "you",
  transitive: "upstream",
  hosted: "vendor",
};
export type VerdictKind = "affected" | "not_affected" | "unknown";

const NO_PRODUCT_DATA = "no version data for this product";
const COMMITS_ONLY = "only code commits";
const NO_CVE_DATA = "no version data for this CVE";
const NO_VERSION = "no version given";

/** The OSV ecosystems Patch has version rules for. */
export type Ecosystem = "PyPI" | "npm" | "Go";

export interface OsvRange {
  introduced: string | null;
  fixed: string | null;
  last_affected: string | null;
}

export interface OsvEntry {
  ecosystem: Ecosystem;
  package: string;
  ranges: OsvRange[];
  fixed: string[];
}

/** One package's newest fixed version, null when OSV lists none for it (B67). */
export interface PackageFix {
  readonly package: string;
  readonly fixed_version: string | null;
}

export interface Verdict {
  readonly verdict: VerdictKind;
  readonly reason: string;
  /** The fix for this version when known; otherwise the newest fix OSV lists. */
  readonly fixed_version: string | null;
  readonly who_acts: WhoActs;
  /** B67: each package's newest fix, in OSV's order, when the CVE spans more than one package; else []. */
  readonly fixes: readonly PackageFix[];
}

/** A comparable version, tagged with its ordering rules. */
export type ParsedVersion =
  | { readonly kind: "pep440"; readonly text: string }
  | { readonly kind: "semver"; readonly sv: SemVer };

/** Which ordering rules each ecosystem's versions follow: npm and Go compare with each other, PyPI with neither. */
const RULES: Record<Ecosystem, ParsedVersion["kind"]> = {
  PyPI: "pep440",
  npm: "semver",
  Go: "semver",
};
const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  PyPI: "PyPI (PEP 440)",
  npm: "semver",
  Go: "Go module",
};
const EXAMPLES: Record<Ecosystem, string> = { PyPI: "0.3.27", npm: "3.1.0", Go: "v0.12.3" };

/** A version an ecosystem can't read: Python's ValueError from parse_version. */
export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

const isEcosystem = (name: string): name is Ecosystem => Object.hasOwn(RULES, name);

/**
 * An ecosystem name as OSV data gives it. Throws, naming it, for one Patch has no version rules for (crates.io,
 * Maven and the rest): a gap in the data or in Patch, not a fault in anyone's version.
 */
export function readEcosystem(name: string): Ecosystem {
  if (isEcosystem(name)) return name;
  throw new Error(
    `OSV ecosystem ${pyRepr(name)} has no version rules here: Patch reads PyPI, npm and Go`,
  );
}

const PYTHON_ESCAPES = new Map([
  ["\\", "\\\\"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\r", "\\r"],
]);
/** What Python's str.isprintable() refuses: Unicode's Other and Separator categories, the space aside. */
const NOT_PRINTABLE = /[\p{C}\p{Z}]/u;
const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

/** Python's repr() of a str: single quotes unless the text holds one and no double quote, and its escapes. */
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const named = PYTHON_ESCAPES.get(ch);
    if (ch === quote) out += "\\" + ch;
    else if (named !== undefined) out += named;
    else if (ch === " " || !NOT_PRINTABLE.test(ch)) out += ch;
    else if (c < 0x100) out += "\\x" + hex(c, 2);
    else if (c < 0x10000) out += "\\u" + hex(c, 4);
    else out += "\\U" + hex(c, 8);
  }
  return quote + out + quote;
}

/** Python's str.isspace() set. JavaScript's trim() differs: it also takes U+FEFF, and leaves \x1c-\x1f and U+0085. */
const PY_SPACE = String.raw`[\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]`;
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu");
/** Python's str.strip(). */
const strip = (s: string): string => s.replace(PY_STRIP, "");

/**
 * What python-semver reads, once Go's one leading "v" is off: a digit first, then SemVer's own characters. npm's
 * semver would also take a second "v", and trim whitespace such as U+FEFF itself.
 */
const SEMVER_TEXT = /^\d[0-9A-Za-z.+-]*$/;

/**
 * python-semver's `optional_minor_and_patch=True`: "1" and "1.2" read as 1.0.0 and 1.2.0, pre-release and build
 * kept. npm's semver has no such switch (coerce() drops or mangles pre-releases), so the core is padded here.
 */
function padSemver(bare: string): string {
  const m = /^([^-+]*)(.*)$/s.exec(bare)!;
  const core = m[1]!;
  const rest = m[2]!;
  const parts = core.split(".");
  if (parts.length > 3) return bare;
  while (parts.length < 3) parts.push("0");
  return parts.join(".") + rest;
}

/**
 * A comparable version in the ecosystem's order. Throws VersionError when the ecosystem can't read it, or when Patch
 * has no version rules for the ecosystem: OSV data comes from JSON, so it may name one the type doesn't (crates.io).
 */
export function parseVersion(ecosystem: Ecosystem, text: string): ParsedVersion {
  if (!isEcosystem(ecosystem)) throw new VersionError(`no version rules for ${pyRepr(ecosystem)}`);
  text = strip(text);
  if (ecosystem === "PyPI") {
    if (pep440.parse(text) !== null) return { kind: "pep440", text };
  } else {
    const bare = text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text;
    const sv = SEMVER_TEXT.test(bare) ? semver.parse(padSemver(bare)) : null;
    if (sv !== null) return { kind: "semver", sv };
  }
  throw new VersionError(`${pyRepr(text)} isn't a ${ECOSYSTEM_LABELS[ecosystem]} version`);
}

/** parseVersion, handing a VersionError's message to `onBad` (which returns or throws) in place of the error. */
function parseOr<T>(
  ecosystem: Ecosystem,
  text: string,
  onBad: (message: string) => T,
): ParsedVersion | T {
  try {
    return parseVersion(ecosystem, text);
  } catch (err) {
    if (err instanceof VersionError) return onBad(err.message);
    throw err;
  }
}

/** <0, 0 or >0. Mixing PyPI with npm or Go throws, as Python's `<` between Version and semver.Version does. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.kind === "pep440" && b.kind === "pep440") return pep440.compare(a.text, b.text);
  if (a.kind === "semver" && b.kind === "semver") return semver.compare(a.sv, b.sv);
  throw new TypeError("can't compare versions from different ecosystems");
}

/** Python's max(): the first of equal items wins, so a later item replaces it only when strictly greater. */
function pyMax<T>(items: readonly T[], cmp: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const x of items) if (best === undefined || cmp(x, best) > 0) best = x;
  return best;
}

/** For products without package data (Dify, llama.cpp). */
const PLAIN_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;

/**
 * Can the product's ecosystems read this version? Throws VersionRefused, with a plain message, when they can't.
 * A product with no package data takes any plain version. An ecosystem Patch has no rules for throws a plain Error.
 */
export function checkVersion(
  productOsv: { packages?: { ecosystem: string }[] },
  name: string,
  version: string,
): void {
  const ecosystems = new Set((productOsv.packages ?? []).map((p) => readEcosystem(p.ecosystem)));
  for (const eco of ecosystems) {
    parseOr(eco, version, () => {
      throw new VersionRefused(
        `${pyRepr(version)} isn't a ${ECOSYSTEM_LABELS[eco]} version, which ${name} uses. ` +
          `Example: ${EXAMPLES[eco]}.`,
      );
    });
  }
  // Python's re.match with `$` also accepts one trailing "\n"; JS's `$` without /m doesn't.
  if (ecosystems.size === 0 && !PLAIN_VERSION.test(version.replace(/\n$/, ""))) {
    throw new VersionRefused(
      `${pyRepr(version)} doesn't look like a version: use letters, digits and . + _ - only.`,
    );
  }
}

/** Python's max() over (parsed, text) tuples: the version first, ties broken by the text. */
function tupleCompare(a: [ParsedVersion, string], b: [ParsedVersion, string]): number {
  const c = compareVersions(a[0], b[0]);
  if (c !== 0) return c;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** The newest fixed version OSV lists. A fixed version the ecosystem can't read is skipped, not an error. */
function newestFix(entries: OsvEntry[]): string | null {
  const fixes: [ParsedVersion, string][] = [];
  for (const e of entries) {
    for (const f of e.fixed) {
      const p = parseOr(e.ecosystem, f, () => null);
      if (p !== null) fixes.push([p, f]);
    }
  }
  return pyMax(fixes, tupleCompare)?.[1] ?? null;
}

/** Each package's newest fix when OSV lists the CVE under more than one package. One package: []. */
export function packageFixes(entries: OsvEntry[]): PackageFix[] {
  const byPackage = new Map<string, OsvEntry[]>(); // keeps insertion order, as a Python dict does
  for (const e of entries) {
    const list = byPackage.get(e.package);
    if (list) list.push(e);
    else byPackage.set(e.package, [e]);
  }
  if (byPackage.size < 2) return [];
  return [...byPackage].map(([p, es]) => ({ package: p, fixed_version: newestFix(es) }));
}

/** "No fix yet" (A16b): OSV lists the CVE and none of its entries has a fixed version. */
export function noFix(coverage: Coverage, entries: OsvEntry[]): boolean {
  if (coverage !== "package" || entries.length === 0) return false;
  return !entries.some((e) => e.fixed.length > 0 || e.ranges.some((r) => Boolean(r.fixed)));
}

/** A version, the user's or OSV's, that its ecosystem can't read: the message is the verdict's whole reason. */
class Unreadable extends Error {}

function makeVerdict(
  verdict: VerdictKind,
  reason: string,
  fixed_version: string | null,
  who_acts: WhoActs,
): Verdict {
  return { verdict, reason, fixed_version, who_acts, fixes: [] };
}

/**
 * The verdict on one CVE for one dependency: `coverage` is the product's OSV coverage, `entries` the CVE's OSV
 * entries for the product's packages, `version` the dependency's version, if any.
 */
export function verdict(
  coverage: Coverage,
  entries: OsvEntry[],
  usage: Usage,
  version: string | null,
): Verdict {
  const who = WHO_ACTS[usage];
  const unknown = (reason: string, fixed: string | null = null): Verdict =>
    makeVerdict("unknown", reason, fixed, who);

  if (coverage === "none") return unknown(NO_PRODUCT_DATA);
  if (coverage === "commits") return unknown(COMMITS_ONLY);
  if (entries.length === 0) return unknown(NO_CVE_DATA);
  const ecosystems = [...new Set(entries.map((e) => e.ecosystem))];
  if (new Set(ecosystems.map((eco) => RULES[eco])).size > 1) {
    // Patch's Python raised a TypeError here; no CVE in its snapshot mixes them.
    return unknown(
      `OSV lists this CVE under ecosystems whose versions don't compare: ${ecosystems.join(", ")}`,
    );
  }
  const newest = newestFix(entries);
  let v: Verdict;
  if (!version || !strip(version)) {
    v = unknown(NO_VERSION, newest);
  } else {
    try {
      v = compare(entries, strip(version), who);
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      v = unknown(err.message, newest);
    }
  }
  return { ...v, fixes: packageFixes(entries) };
}

const isStart = (s: string | null): boolean => s === "0" || s === null;

/** Throws Unreadable for a version, the user's or OSV's, that its ecosystem can't read. */
function compare(entries: OsvEntry[], version: string, who: WhoActs): Verdict {
  const passed: [ParsedVersion, string, OsvEntry][] = []; // fixes at or below this version
  for (const e of entries) {
    const mine = parseOr(e.ecosystem, version, (message) => {
      throw new Unreadable(`version not understood: ${message}`);
    });
    const v = (text: string): ParsedVersion =>
      parseOr(e.ecosystem, text, (message) => {
        throw new Unreadable(`OSV version not understood: ${message}`);
      });
    for (const r of e.ranges) {
      if (!isStart(r.introduced) && compareVersions(mine, v(r.introduced!)) < 0) continue;
      if (r.fixed) {
        if (compareVersions(mine, v(r.fixed)) < 0) {
          const reason = `${version} is before the fixed version ${r.fixed}` + packageSuffix(e);
          return affected(reason, r.fixed, e, entries, who);
        }
        passed.push([v(r.fixed), r.fixed, e]);
      } else if (r.last_affected) {
        if (compareVersions(mine, v(r.last_affected)) <= 0) {
          const reason =
            `${version} is at or before the last affected version ` +
            `${r.last_affected}${packageSuffix(e)}; no fixed version listed`;
          return affected(reason, null, e, entries, who);
        }
      } else {
        const reason = `${version} is in an affected range with no fix yet` + packageSuffix(e);
        return affected(reason, null, e, entries, who);
      }
    }
  }
  const best = pyMax(passed, (a, b) => compareVersions(a[0], b[0]));
  if (best) {
    const [, fix, e] = best;
    const reason = `${version} is at or after the fixed version ${fix}` + packageSuffix(e);
    return makeVerdict("not_affected", reason, fix, who);
  }
  const reason = `${version} is outside the affected versions` + packageSuffix(entries[0]!);
  return makeVerdict("not_affected", reason, null, who);
}

/** An "affected" verdict, its reason naming any other package with a different fix (B67). */
function affected(
  reason: string,
  fixed: string | null,
  e: OsvEntry,
  entries: OsvEntry[],
  who: WhoActs,
): Verdict {
  const others = packageFixes(entries).filter(
    (f) => f.package !== e.package && f.fixed_version !== fixed,
  );
  const parts = others.map((f) => {
    const ranges = entries.filter((o) => o.package === f.package).flatMap((o) => o.ranges);
    const start = ranges.length === 1 ? ranges[0]!.introduced : null;
    return (
      f.package +
      (!isStart(start) ? ` from ${start}` : "") +
      (f.fixed_version ? `, fixed in ${f.fixed_version}` : ", no fix listed")
    );
  });
  const alsoLists = parts.length ? "; OSV also lists " + parts.join("; ") : "";
  return makeVerdict("affected", reason + alsoLists, fixed, who);
}

/**
 * The reason's " (package)" suffix: for LangChain it may be langchain-core, a different version line from the one
 * given.
 */
function packageSuffix(e: OsvEntry): string {
  return ` (${e.package})`;
}
