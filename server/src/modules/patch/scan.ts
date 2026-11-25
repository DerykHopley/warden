/**
 * The Patch Scan (spec #101, stories 3, 4 and 8): for each of a Product's dependencies and each CVE on its framework,
 * the verdict decides; `affected` and `unknown` are each one Observation on the Product, `not_affected` none. One
 * Product is one Scan through `findings.scanLocked`, so a Finding the Scan doesn't see again turns Fixed: an upgrade
 * past the fix, a dependency removed, or the Product deleted (stored with no dependencies). Saving a Product runs it,
 * and so does the daily Job's Patch step (refresh.ts). It refuses to run before `load-cves` has loaded the snapshot.
 */
import type { Framework, Observation, Product, ProductDependency } from "@warden/contracts";
import type { Transaction } from "kysely";
import type { Findings, ReconcileOutcome } from "../../findings/index.ts";
import type { Logger } from "../../log.ts";
import type { Database } from "../../schema.ts";
import { cvssSeverity } from "./cvss-band.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import { readDependencies } from "./products.ts";
import {
  isEcosystem,
  readEcosystem,
  verdict,
  type Ecosystem,
  type OsvEntry,
  type Verdict,
} from "./verdict.ts";

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
   * One Scan of Product `product.id` as stored when the Scan reconciles: its dependencies are read under the Team's
   * Findings lock, whatever `product` holds, so a Scan that runs late never undoes a newer change. A Product the Team
   * doesn't have (one just deleted) has no dependencies, so every Finding on it turns Fixed.
   */
  scanProduct(team: string, product: Pick<Product, "id">): Promise<ReconcileOutcome>;
}

/** Each OSV ecosystem's purl type. */
const PURL_TYPES: Record<Ecosystem, string> = { PyPI: "pypi", npm: "npm", Go: "golang" };

/**
 * A package as a purl without its version (the contracts README's Fingerprint rule): PyPI's name in lower case with
 * `-` for `_`, npm's name and Go's module path as they are. Throws, naming it, for an ecosystem with no rule here.
 */
export function osvPurl(ecosystem: string, name: string): string {
  const known = readEcosystem(ecosystem);
  return `pkg:${PURL_TYPES[known]}/${known === "PyPI" ? name.toLowerCase().replaceAll("_", "-") : name}`;
}

/**
 * A CVE's Location package: the purl of its first OSV entry; with none, or one in an ecosystem Patch has no purl rule
 * for, the framework's first purl; with no purls (llama.cpp, Dify, AnythingLLM), `pkg:generic/<framework id>`.
 */
export function cvePackage(framework: Framework, entries: readonly OsvEntry[]): string {
  const [first] = entries;
  if (first !== undefined && isEcosystem(first.ecosystem)) {
    return osvPurl(first.ecosystem, first.package);
  }
  return framework.purls[0] ?? `pkg:generic/${framework.id}`;
}

/**
 * `text` whole when it fits in `max` UTF-16 units, else cut to fit with `…` last. A cut never splits a character
 * made of two units (an emoji, say): it drops the first half too.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, max - 1);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

/**
 * The description's first sentence, its line breaks and runs of spaces as one space. A sentence ends at `.`, `!` or
 * `?` before the end or a space and a capital letter, never at "e.g." or "i.e.".
 */
function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return /^.*?(?<!\b(?:[Ee]\.g|[Ii]\.e))[.!?](?=$| \p{Lu})/u.exec(text)?.[0] ?? text;
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
function verdictWords(version: string, outcome: Verdict): string {
  const is = outcome.verdict === "affected" ? "is affected" : "may be affected";
  return `Version ${version} ${is}: ${outcome.reason}`;
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
  purl: string,
  outcome: Verdict,
): Observation {
  if (outcome.verdict === "not_affected") {
    throw new Error(`${cve.id} doesn't affect this version: it gives no Observation`);
  }
  const version = dependency.version ?? "unknown";
  const sentence = firstSentence(cve.description);
  const fix =
    outcome.fixed_version === null ? "no fix listed" : `${outcome.fixed_version} fixes it`;
  return {
    asset: { kind: "product", ref: productId },
    rule_id: PATCH_RULE,
    location: { kind: "dependency", package: purl, version, vulnerability: cve.id },
    severity: cvssSeverity(cve.cvss, cve.severity).severity,
    title: cut(sentence === "" ? cve.id : `${cve.id}: ${sentence}`, TITLE_MAX),
    evidence: {
      summary: cut(`${scoreWords(cve)}. ${verdictWords(version, outcome)}; ${fix}.`, SUMMARY_MAX),
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

/**
 * Throws unless the CVE snapshot is loaded (`cve_snapshot` has its row). Before `load-cves` has run the CVE tables are
 * empty, and a Scan reconciling against them would see no CVE and turn every CVE Finding on the Product Fixed.
 */
async function requireSnapshot(tx: Transaction<Database>): Promise<void> {
  const loaded = await tx.selectFrom("cve_snapshot").select("as_of").executeTakeFirst();
  if (loaded === undefined) {
    throw new Error(
      "the CVE snapshot isn't loaded (cve_snapshot has no row): run load-cves " +
        "(pnpm --filter @warden/server load-cves) before a Patch Scan. Nothing was changed",
    );
  }
}

/**
 * The Product, its CVE tables and its Findings are all read in the one Team transaction that reconciles, under the
 * Team's Findings lock. The CVE tables are reference data, the same for every Team; with no snapshot loaded the Scan
 * throws (`requireSnapshot`), recording nothing. `logger` records a dependency the Scan skips.
 */
export function createPatchScan({
  findings,
  logger,
}: {
  findings: Findings;
  logger: Logger;
}): PatchScan {
  return {
    scanProduct: (team, { id }) =>
      findings.scanLocked(
        { team, module: "patch", assets: [{ kind: "product", ref: id }], rules: [PATCH_RULE] },
        async (scan, tx) => {
          await requireSnapshot(tx);
          const known: { dependency: ProductDependency; framework: Framework }[] = [];
          for (const dependency of await readDependencies(tx, id)) {
            const framework = PATCH_FRAMEWORKS.find((f) => f.id === dependency.framework);
            if (framework === undefined) {
              // Stored before its framework left PATCH_FRAMEWORKS: its CVEs can't be read, the rest still can.
              logger.error(
                "the Patch Scan skipped a dependency on a framework Patch doesn't know",
                {
                  team,
                  productId: id,
                  framework: dependency.framework,
                },
              );
              continue;
            }
            known.push({ dependency, framework });
          }
          const cves = await readCves(
            tx,
            known.map(({ framework }) => framework.id),
          );
          for (const { dependency, framework } of known) {
            for (const cve of cves.get(framework.id) ?? []) {
              const outcome = verdict(
                framework.coverage,
                cve.entries,
                dependency.usage,
                dependency.version,
              );
              if (outcome.verdict === "not_affected") continue;
              scan.saw(
                cveObservation(id, dependency, cve, cvePackage(framework, cve.entries), outcome),
              );
            }
          }
        },
      ),
  };
}
