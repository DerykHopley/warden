/**
 * The Patch Scan (spec #101, stories 3, 4 and 8): for each of a Product's dependencies and each CVE on its framework,
 * the verdict decides; `affected` and `unknown` are each one Observation on the Product, `not_affected` none. One
 * Product is one Scan through `findings.scan`, so a Finding the Scan doesn't see again turns Fixed: an upgrade past
 * the fix, a dependency removed, or the Product deleted (scanned with no dependencies). Saving a Product runs it; the
 * daily refresh will too.
 */
import type { Framework, Observation, Product, ProductDependency } from "@warden/contracts";
import type { Transaction } from "kysely";
import type { Findings, ReconcileOutcome } from "../../findings/index.ts";
import type { Database } from "../../schema.ts";
import type { WithTeam } from "../../with-team.ts";
import { cvssSeverity } from "./cvss-band.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import { verdict, type OsvEntry, type Verdict } from "./verdict.ts";

export const PATCH_RULE = "patch/known-vulnerability";

/** Finding v1's Title and Evidence summary limits. */
const TITLE_MAX = 200;
const SUMMARY_MAX = 2000;

/** What an Observation tells of one CVE: its NVD row, and whether CISA's KEV lists it. */
export interface CveFacts {
  id: string;
  cvss: number | null;
  /** NVD's severity word as stored, NONE and null included. */
  severity: string | null;
  description: string;
  in_kev: boolean;
}

/** A CVE on one framework, with its OSV entries for that framework in OSV's order. */
interface FrameworkCve extends CveFacts {
  entries: OsvEntry[];
}

export interface PatchScan {
  /**
   * One Scan of the Product as given: its Findings become what its dependencies show now. A Product with no
   * dependencies (one just deleted) turns every Finding on it Fixed.
   */
  scanProduct(
    team: string,
    product: Pick<Product, "id" | "dependencies">,
  ): Promise<ReconcileOutcome>;
}

/** Each OSV ecosystem's purl type. */
const PURL_TYPES: Record<string, string> = { PyPI: "pypi", npm: "npm", Go: "golang" };

/**
 * A package as a purl without its version (the contracts README's Fingerprint rule): PyPI's name in lower case with
 * `-` for `_`, npm's name and Go's module path as they are. Throws, naming it, for an ecosystem with no rule here.
 */
export function osvPurl(ecosystem: string, name: string): string {
  const type = Object.hasOwn(PURL_TYPES, ecosystem) ? PURL_TYPES[ecosystem] : undefined;
  if (type === undefined) {
    throw new Error(
      `no purl rule for the OSV ecosystem "${ecosystem}": Patch reads PyPI, npm and Go`,
    );
  }
  return `pkg:${type}/${ecosystem === "PyPI" ? name.toLowerCase().replaceAll("_", "-") : name}`;
}

/**
 * A CVE's Location package: the purl of its first OSV entry; with none, the framework's first purl; with no purls
 * (llama.cpp, Dify, AnythingLLM), `pkg:generic/<framework id>`.
 */
export function cvePackage(framework: Framework, entries: readonly OsvEntry[]): string {
  const [first] = entries;
  if (first !== undefined) return osvPurl(first.ecosystem, first.package);
  return framework.purls[0] ?? `pkg:generic/${framework.id}`;
}

/** `text` whole when it fits in `max` characters, else cut to `max` with `…` last. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The description's first sentence, its line breaks and runs of spaces as one space. */
function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?= |$)/.exec(text)?.[0] ?? text;
}

/** The score, or NVD's word when it gave no score, or "not scored yet"; then KEV. */
function scoreWords({ cvss, severity, in_kev }: CveFacts): string {
  const { scored } = cvssSeverity(cvss, severity);
  const score = !scored
    ? "CVSS not scored yet"
    : cvss === null
      ? `No CVSS score, NVD rates it ${severity}`
      : `CVSS ${cvss.toFixed(1)}`;
  return in_kev ? `${score}, in CISA KEV` : score;
}

/** The verdict and its reason. */
function verdictWords(version: string, v: Verdict): string {
  const is = v.verdict === "affected" ? "is affected" : "may be affected";
  return `Version ${version} ${is}: ${v.reason}`;
}

/**
 * The Observation for one CVE on one of a Product's dependencies, under an `affected` or `unknown` verdict. Its
 * Title is the CVE id and the description's first sentence; its summary names the score (or "not scored yet"), KEV,
 * the verdict and its reason, and the fix (or "no fix listed").
 */
export function cveObservation(
  productId: string,
  dependency: ProductDependency,
  cve: CveFacts,
  pkg: string,
  v: Verdict,
): Observation {
  if (v.verdict === "not_affected") {
    throw new Error(`${cve.id} doesn't affect this version: it gives no Observation`);
  }
  const version = dependency.version ?? "unknown";
  const sentence = firstSentence(cve.description);
  const fix = v.fixed_version === null ? "no fix listed" : `${v.fixed_version} fixes it`;
  return {
    asset: { kind: "product", ref: productId },
    rule_id: PATCH_RULE,
    location: { kind: "dependency", package: pkg, version, vulnerability: cve.id },
    severity: cvssSeverity(cve.cvss, cve.severity).severity,
    title: cut(sentence === "" ? cve.id : `${cve.id}: ${sentence}`, TITLE_MAX),
    evidence: {
      summary: cut(`${scoreWords(cve)}. ${verdictWords(version, v)}; ${fix}.`, SUMMARY_MAX),
    },
  };
}

/** Each of `frameworks`' CVEs, with KEV and its OSV entries for that framework, by framework id. */
async function readCves(
  tx: Transaction<Database>,
  frameworks: string[],
): Promise<Map<string, FrameworkCve[]>> {
  const byFramework = new Map<string, FrameworkCve[]>();
  if (frameworks.length === 0) return byFramework;
  const cves = await tx
    .selectFrom("cves as c")
    .leftJoin("cve_kev as k", "k.cve_id", "c.id")
    .select(["c.id", "c.product", "c.cvss", "c.severity", "c.description", "k.cve_id as kev_id"])
    .where("c.product", "in", frameworks)
    .orderBy("c.id")
    .execute();
  const osv = await tx
    .selectFrom("cve_osv")
    .select(["cve_id", "product", "ecosystem", "package", "ranges", "fixed"])
    .where("product", "in", frameworks)
    .orderBy("position")
    .execute();
  const entries = new Map<string, OsvEntry[]>();
  for (const { cve_id, product, ...entry } of osv) {
    const key = `${product}\n${cve_id}`;
    entries.set(key, [...(entries.get(key) ?? []), entry]);
  }
  for (const { kev_id, product, ...cve } of cves) {
    const list = byFramework.get(product) ?? [];
    list.push({
      ...cve,
      in_kev: kev_id !== null,
      entries: entries.get(`${product}\n${cve.id}`) ?? [],
    });
    byFramework.set(product, list);
  }
  return byFramework;
}

function frameworkOf(id: string): Framework {
  const framework = PATCH_FRAMEWORKS.find((f) => f.id === id);
  if (framework === undefined)
    throw new Error(`a dependency names "${id}", a framework Patch doesn't know`);
  return framework;
}

/** The CVE tables are reference data, the same for every Team; they're read in the Team's transaction all the same. */
export function createPatchScan({
  findings,
  withTeam,
}: {
  findings: Findings;
  withTeam: WithTeam;
}): PatchScan {
  return {
    scanProduct: (team, { id, dependencies }) =>
      findings.scan(
        { team, module: "patch", assets: [{ kind: "product", ref: id }], rules: [PATCH_RULE] },
        async (scan) => {
          const cves = await withTeam(team, (tx) =>
            readCves(
              tx,
              dependencies.map(({ framework }) => framework),
            ),
          );
          for (const dependency of dependencies) {
            const framework = frameworkOf(dependency.framework);
            for (const cve of cves.get(framework.id) ?? []) {
              const v = verdict(
                framework.coverage,
                cve.entries,
                dependency.usage,
                dependency.version,
              );
              if (v.verdict === "not_affected") continue;
              scan.saw(cveObservation(id, dependency, cve, cvePackage(framework, cve.entries), v));
            }
          }
        },
      ),
  };
}
