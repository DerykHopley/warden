/**
 * One Patch Finding's assessment (spec #101, stories 5 and 6): the verdict on the Finding's version, the fix, who
 * acts, and the priority with its due date, worked out when asked from the Finding, the Product's dependency as stored
 * now and the loaded CVE snapshot. Nothing is stored, and Finding v1 is unchanged.
 */
import { PatchAssessment, type Finding, type ProductDependency } from "@warden/contracts";
import { sql } from "kysely";
import { findingOf, type Findings } from "../../findings/index.ts";
import type { WithTeam } from "../../with-team.ts";
import { cvssSeverity, type NvdSeverity } from "./cvss-band.ts";
import { CveNotInSnapshot, PatchFindingNotFound } from "./errors.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import { PATCH_POLICY, priority, utcDay } from "./priority.ts";
import { readDependencies } from "./products.ts";
import { cut } from "./scan.ts";
import { noFix, verdict, type OsvEntry } from "./verdict.ts";

/** The longest reason the contract takes: a longer one is cut to fit. */
const REASON_MAX = PatchAssessment.shape.reason.maxLength ?? Infinity;

/** What the CVE snapshot holds for one CVE, its dates as YYYY-MM-DD. */
export interface CveRecord {
  id: string;
  /** The framework id NVD's CVE was matched to (`cves.product`). */
  framework: string;
  published: string;
  /** NVD's severity word as stored, NONE and null included. */
  severity: string | null;
  cvss: number | null;
  url: string;
  kev: { date_added: string; due_date: string; required_action: string } | null;
  epss: { score: number; percentile: number; date: string } | null;
  /** Its OSV entries for that framework, in OSV's order, each with its advisory id. */
  osv: (OsvEntry & { advisory: string })[];
}

/** A Patch Finding as the assessment reads it: on a Product, its CVE its Location's `vulnerability`. */
type PatchFinding = Finding & {
  asset: { kind: "product" };
  location: Extract<Finding["location"], { kind: "dependency" }> & { vulnerability: string };
};

/** Patch's, on a Product Asset, with a CVE to assess: anything else isn't a Patch Finding the assessment reads. */
function isPatchFinding(finding: Finding): finding is PatchFinding {
  return (
    finding.module === "patch" &&
    finding.asset.kind === "product" &&
    finding.location.kind === "dependency" &&
    finding.location.vulnerability !== undefined
  );
}

/**
 * The assessment of `finding` on `cve`, for the Product's `dependency` on the CVE's framework (null when it's gone),
 * as of `now`: "today" is its UTC day.
 */
export function assess(
  finding: PatchFinding,
  dependency: ProductDependency | null,
  cve: CveRecord,
  now: Date,
): PatchAssessment {
  // A framework that left PATCH_FRAMEWORKS has no OSV coverage Patch can read: its verdict is unknown.
  const coverage = PATCH_FRAMEWORKS.find((f) => f.id === cve.framework)?.coverage ?? "none";
  const entries: OsvEntry[] = cve.osv;
  const version = finding.location.version === "unknown" ? null : finding.location.version;
  // With the dependency gone there's no usage, and who acts is null; usage changes nothing else in the verdict.
  const outcome = verdict(coverage, entries, dependency?.usage ?? "library", version);
  const band = cvssSeverity(cve.cvss, cve.severity);
  const due = priority(
    {
      severity: band.scored ? (band.severity.toUpperCase() as NvdSeverity) : null,
      kev: cve.kev !== null,
      kev_added: cve.kev?.date_added ?? null,
      kev_deadline: cve.kev?.due_date ?? null,
      epss_percentile: cve.epss?.percentile ?? null,
      verdict: outcome.verdict,
      internet_facing: dependency?.internet_facing ?? false,
      status: finding.status,
      review_date:
        finding.status === "accepted" && finding.accepted_until !== null
          ? utcDay(new Date(finding.accepted_until))
          : null,
      published: cve.published,
      no_fix: noFix(coverage, entries),
    },
    PATCH_POLICY,
    utcDay(now),
  );
  // An acceptance ends at its exact time, at or before now as the daily expiry reads it, not on its UTC day: before
  // then the Finding isn't overdue, even on the day it ends. The review date only ever says the same or earlier.
  const acceptanceEnded =
    finding.status !== "accepted" ||
    finding.accepted_until === null ||
    new Date(finding.accepted_until) <= now;
  const advisories = [...new Set(cve.osv.map((e) => e.advisory).filter((a) => a !== ""))];
  return {
    finding_id: finding.id,
    cve_id: cve.id,
    dependency,
    verdict: outcome.verdict,
    reason: cut(outcome.reason, REASON_MAX),
    fixed_version: outcome.fixed_version,
    fixes: [...outcome.fixes],
    who_acts: dependency === null ? null : outcome.who_acts,
    priority: {
      level: due.level,
      reasons: [...due.reasons],
      due_date: due.due_date,
      due_from: due.due_from,
      overdue: due.overdue && acceptanceEnded,
    },
    kev: cve.kev,
    epss: cve.epss,
    links: {
      nvd: cve.url,
      osv: advisories.map((a) => `https://osv.dev/vulnerability/${encodeURIComponent(a)}`),
    },
  };
}

export interface PatchAssessments {
  /**
   * Finding `findingId`'s assessment under `team`, as of now. Throws PatchFindingNotFound for an id that isn't one of
   * the Team's Patch Findings, and CveNotInSnapshot for a Patch Finding whose CVE the loaded snapshot doesn't hold.
   */
  read(team: string, findingId: string): Promise<PatchAssessment>;
}

/** A date column as YYYY-MM-DD, read as text so no time zone shifts it; `T` is string | null for a left join's. */
const day = <T extends string | null = string>(column: string) =>
  sql<T>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`;

/**
 * The Finding is read through `findings`; the Product's dependencies and the CVE tables (reference data, the same for
 * every Team) through `withTeam`, in one transaction. `now` is the clock "today" is read from.
 */
export function createPatchAssessment({
  findings,
  withTeam,
  now = () => new Date(),
}: {
  findings: Findings;
  withTeam: WithTeam;
  now?: () => Date;
}): PatchAssessments {
  return {
    async read(team, findingId) {
      const finding = await findingOf(findings, team, findingId, PatchFindingNotFound);
      if (!isPatchFinding(finding)) throw new PatchFindingNotFound(findingId);
      const cveId = finding.location.vulnerability;
      const asOf = now();

      return withTeam(team, async (tx) => {
        const cve = await tx
          .selectFrom("cves as c")
          .leftJoin("cve_kev as k", "k.cve_id", "c.id")
          .leftJoin("cve_epss as e", "e.cve_id", "c.id")
          .select([
            "c.id",
            "c.product",
            day("c.published").as("published"),
            "c.severity",
            "c.cvss",
            "c.url",
            day<string | null>("k.date_added").as("kev_added"),
            day<string | null>("k.due_date").as("kev_due"),
            "k.required_action",
            "e.score",
            "e.percentile",
            day<string | null>("e.date").as("epss_date"),
          ])
          .where("c.id", "=", cveId)
          .executeTakeFirst();
        if (cve === undefined) throw new CveNotInSnapshot(cveId);
        const osv = await tx
          .selectFrom("cve_osv")
          .select(["ecosystem", "package", "advisory", "ranges", "fixed"])
          .where("cve_id", "=", cveId)
          .where("product", "=", cve.product)
          .orderBy("position")
          .execute();
        const dependencies = await readDependencies(tx, finding.asset.ref);
        const record: CveRecord = {
          id: cve.id,
          framework: cve.product,
          published: cve.published,
          severity: cve.severity,
          cvss: cve.cvss,
          url: cve.url,
          kev:
            cve.kev_added === null || cve.kev_due === null || cve.required_action === null
              ? null
              : {
                  date_added: cve.kev_added,
                  due_date: cve.kev_due,
                  required_action: cve.required_action,
                },
          epss:
            cve.score === null || cve.percentile === null || cve.epss_date === null
              ? null
              : { score: cve.score, percentile: cve.percentile, date: cve.epss_date },
          osv,
        };
        const dependency = dependencies.find((d) => d.framework === cve.product) ?? null;
        return assess(finding, dependency, record, asOf);
      });
    },
  };
}
