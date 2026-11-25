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
import semver from "semver";
import type { SemVer } from "semver";
import { VersionRefused } from "./errors.ts";

export const USAGES = ["self_hosted", "library", "transitive", "hosted"] as const;
export type Usage = (typeof USAGES)[number];
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
export const VERDICTS = ["affected", "not_affected", "unknown"] as const;
export type VerdictKind = (typeof VERDICTS)[number];

const NO_PRODUCT_DATA = "no version data for this product";
const COMMITS_ONLY = "only code commits";
const NO_CVE_DATA = "no version data for this CVE";
const NO_VERSION = "no version given";

type Ecosystem = "PyPI" | "npm" | "Go";

export interface OsvRange {
  introduced: string | null;
  fixed: string | null;
  last_affected: string | null;
}

export interface OsvEntry {
  ecosystem: string;
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

/** A version an ecosystem can't read: Python's ValueError from parse_version. */
export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

/** Python's repr() of a str, enough for version text: single quotes unless the text holds one. */
function pyRepr(text: string): string {
  if (text.includes("'") && !text.includes('"')) return `"${text}"`;
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python's str.strip(): JS trim() covers the same whitespace for version text. */
const strip = (s: string): string => s.trim();

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

/** A comparable version in the ecosystem's order. Throws VersionError when the ecosystem can't read it. */
export function parseVersion(ecosystem: string, text: string): ParsedVersion {
  text = strip(text);
  if (ecosystem === "PyPI") {
    if (pep440.parse(text) === null) {
      throw new VersionError(`${pyRepr(text)} isn't a PyPI (PEP 440) version`);
    }
    return { kind: "pep440", text };
  }
  if (ecosystem === "npm" || ecosystem === "Go") {
    const bare = text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text;
    const sv = semver.parse(padSemver(bare));
    if (sv === null) {
      const rules = ecosystem === "Go" ? "Go module" : "semver";
      throw new VersionError(`${pyRepr(text)} isn't a ${rules} version`);
    }
    return { kind: "semver", sv };
  }
  throw new VersionError(`no version rules for ${pyRepr(ecosystem)}`);
}

/** <0, 0 or >0. Mixing ecosystems throws, as Python's `<` between Version and semver.Version does. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.kind === "pep440" && b.kind === "pep440") return pep440.compare(a.text, b.text);
  if (a.kind === "semver" && b.kind === "semver") return semver.compare(a.sv, b.sv);
  throw new TypeError("can't compare versions from different ecosystems");
}

const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  PyPI: "PyPI (PEP 440)",
  npm: "semver",
  Go: "Go module",
};
const EXAMPLES: Record<Ecosystem, string> = { PyPI: "0.3.27", npm: "3.1.0", Go: "v0.12.3" };
/** For products without package data (Dify, llama.cpp). */
const PLAIN_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;

/**
 * Can the product's ecosystems read this version? Throws VersionRefused, with a plain message, when they can't.
 * A product with no package data takes any plain version.
 */
export function checkVersion(
  productOsv: { packages?: { ecosystem: string }[] },
  name: string,
  version: string,
): void {
  const ecosystems = [...new Set((productOsv.packages ?? []).map((p) => p.ecosystem))];
  for (const eco of ecosystems) {
    try {
      parseVersion(eco, version);
    } catch (err) {
      if (!(err instanceof VersionError)) throw err;
      const e = eco as Ecosystem;
      throw new VersionRefused(
        `${pyRepr(version)} isn't a ${ECOSYSTEM_LABELS[e]} version, which ${name} uses. ` +
          `Example: ${EXAMPLES[e]}.`,
      );
    }
  }
  // Python's re.match with `$` also accepts one trailing "\n"; JS's `$` without /m doesn't.
  if (ecosystems.length === 0 && !PLAIN_VERSION.test(version.replace(/\n$/, ""))) {
    throw new VersionRefused(
      `${pyRepr(version)} doesn't look like a version: use letters, digits and . + _ - only.`,
    );
  }
}

function readable(ecosystem: string, text: string): ParsedVersion | null {
  try {
    return parseVersion(ecosystem, text);
  } catch (err) {
    if (err instanceof VersionError) return null;
    throw err;
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
      const p = readable(e.ecosystem, f);
      if (p !== null) fixes.push([p, f]);
    }
  }
  if (fixes.length === 0) return null;
  // Python's max() keeps the first of equal items: replace only on strictly greater.
  let best = fixes[0]!;
  for (const x of fixes.slice(1)) if (tupleCompare(x, best) > 0) best = x;
  return best[1];
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
export function noFix(coverage: string, entries: OsvEntry[]): boolean {
  if (coverage !== "package" || entries.length === 0) return false;
  return !entries.some((e) => e.fixed.length > 0 || e.ranges.some((r) => Boolean(r.fixed)));
}

/** A version in OSV's own data that its ecosystem's rules can't read. */
class BadOsvVersion extends Error {}

/**
 * The verdict on one CVE for one dependency: `coverage` is the product's OSV coverage (package, commits or none),
 * `entries` the CVE's OSV entries for the product's packages, `version` the dependency's version, if any.
 */
export function verdict(
  coverage: string,
  entries: OsvEntry[],
  usage: Usage,
  version: string | null,
): Verdict {
  const who = WHO_ACTS[usage];
  const unknown = (reason: string, fixed: string | null = null): Verdict => ({
    verdict: "unknown",
    reason,
    fixed_version: fixed,
    who_acts: who,
    fixes: [],
  });

  if (coverage === "none") return unknown(NO_PRODUCT_DATA);
  if (coverage === "commits") return unknown(COMMITS_ONLY);
  if (entries.length === 0) return unknown(NO_CVE_DATA);
  const newest = newestFix(entries);
  let v: Verdict;
  if (!version || !strip(version)) {
    v = unknown(NO_VERSION, newest);
  } else {
    try {
      v = compare(entries, strip(version), who, newest);
    } catch (err) {
      if (!(err instanceof BadOsvVersion)) throw err;
      v = unknown(`OSV version not understood: ${err.message}`, newest);
    }
  }
  return { ...v, fixes: packageFixes(entries) };
}

const isStart = (s: string | null): boolean => s === "0" || s === null;

function compare(
  entries: OsvEntry[],
  version: string,
  who: WhoActs,
  newest: string | null,
): Verdict {
  const passed: [ParsedVersion, string, OsvEntry][] = []; // fixes at or below this version
  for (const e of entries) {
    let mine: ParsedVersion;
    try {
      mine = parseVersion(e.ecosystem, version);
    } catch (err) {
      if (!(err instanceof VersionError)) throw err;
      return {
        verdict: "unknown",
        reason: `version not understood: ${err.message}`,
        fixed_version: newest,
        who_acts: who,
        fixes: [],
      };
    }
    const v = (text: string): ParsedVersion => {
      try {
        return parseVersion(e.ecosystem, text);
      } catch (err) {
        if (err instanceof VersionError) throw new BadOsvVersion(err.message);
        throw err;
      }
    };
    for (const r of e.ranges) {
      if (!isStart(r.introduced) && compareVersions(mine, v(r.introduced!)) < 0) continue;
      if (r.fixed) {
        if (compareVersions(mine, v(r.fixed)) < 0) {
          const reason = `${version} is before the fixed version ${r.fixed}` + pkg(e);
          return affected(reason, r.fixed, e, entries, who);
        }
        passed.push([v(r.fixed), r.fixed, e]);
      } else if (r.last_affected) {
        if (compareVersions(mine, v(r.last_affected)) <= 0) {
          const reason =
            `${version} is at or before the last affected version ` +
            `${r.last_affected}${pkg(e)}; no fixed version listed`;
          return affected(reason, null, e, entries, who);
        }
      } else {
        const reason = `${version} is in an affected range with no fix yet` + pkg(e);
        return affected(reason, null, e, entries, who);
      }
    }
  }
  if (passed.length > 0) {
    // max(passed, key=...) keeps the first of equal keys
    let best = passed[0]!;
    for (const p of passed.slice(1)) if (compareVersions(p[0], best[0]) > 0) best = p;
    const [, fix, e] = best;
    return {
      verdict: "not_affected",
      reason: `${version} is at or after the fixed version ${fix}` + pkg(e),
      fixed_version: fix,
      who_acts: who,
      fixes: [],
    };
  }
  return {
    verdict: "not_affected",
    reason: `${version} is outside the affected versions` + pkg(entries[0]!),
    fixed_version: null,
    who_acts: who,
    fixes: [],
  };
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
  return {
    verdict: "affected",
    reason: reason + (parts.length ? "; OSV also lists " + parts.join("; ") : ""),
    fixed_version: fixed,
    who_acts: who,
    fixes: [],
  };
}

/** Names the package: for LangChain it may be langchain-core, a different version line from the one given. */
function pkg(e: OsvEntry): string {
  return ` (${e.package})`;
}
