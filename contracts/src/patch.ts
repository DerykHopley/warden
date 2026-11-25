// One Patch Finding's assessment, as `GET /api/patch/findings/:id/assessment` answers it (Patch, spec #101, stories 5
// and 6): whether the version is affected and why, which version fixes it, who acts, and how urgent it is. Worked out
// when asked, from the Finding, the Product as stored now and the loaded CVE snapshot; nothing of it is stored, and
// Finding v1 is unchanged.
import { z } from "zod";
import { Id, Text } from "./finding.ts";
import { ProductDependency } from "./products.ts";

/** Whether a CVE touches the version in use: Patch's verdict.py values. */
export const VerdictKind = z.enum(["affected", "not_affected", "unknown"]);
export type VerdictKind = z.infer<typeof VerdictKind>;

/** Who acts on a CVE, from how the Product uses the framework: you, the package that brings it in, or the vendor. */
export const WhoActs = z.enum(["you", "upstream", "vendor"]);
export type WhoActs = z.infer<typeof WhoActs>;

/** How urgent a CVE is for the Team, highest first. */
export const PriorityLevel = z.enum(["urgent", "high", "normal", "low"]);
export type PriorityLevel = z.infer<typeof PriorityLevel>;

/** A calendar day, YYYY-MM-DD. */
const Day = z.iso.date();

/** A score or percentile from 0 to 1. */
const Fraction = z.number().min(0).max(1);

export const PatchAssessment = z.strictObject({
  finding_id: Id,
  /** The Finding Location's `vulnerability`. */
  cve_id: Id,
  /**
   * The Product's dependency on the CVE's framework, as stored now; null when the Product, or its dependency on that
   * framework, is gone (a Fixed Finding after a removal).
   */
  dependency: ProductDependency.nullable(),
  /** For the Finding Location's version (`"unknown"` read as none), not the dependency's version now. */
  verdict: VerdictKind,
  reason: Text(2000),
  /** The fix for this version when known; otherwise the newest fix OSV lists; null when it lists none. */
  fixed_version: z.string().min(1).nullable(),
  /** Each package's newest fix, in OSV's order, when OSV lists the CVE under more than one package; else []. */
  fixes: z.array(z.strictObject({ package: Id, fixed_version: z.string().min(1).nullable() })),
  /** Null when `dependency` is. */
  who_acts: WhoActs.nullable(),
  priority: z.strictObject({
    level: PriorityLevel,
    reasons: z.array(Text(200)),
    due_date: Day,
    /** Such as "KEV deadline", "published + 90 days" or "added to KEV + 7 days". */
    due_from: Text(200),
    overdue: z.boolean(),
  }),
  /** CISA's KEV entry, or null when KEV doesn't list the CVE. */
  kev: z.strictObject({ date_added: Day, due_date: Day, required_action: z.string() }).nullable(),
  /** FIRST's EPSS score and percentile on their date, or null when EPSS has none. */
  epss: z.strictObject({ score: Fraction, percentile: Fraction, date: Day }).nullable(),
  links: z.strictObject({
    /** The CVE's NVD page. */
    nvd: z.url(),
    /** One page per distinct OSV advisory for the CVE, in OSV's order; empty when OSV has none. */
    osv: z.array(z.url()),
  }),
});
export type PatchAssessment = z.infer<typeof PatchAssessment>;
