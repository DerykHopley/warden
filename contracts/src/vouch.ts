// Vouch's Catalogues as the API answers and takes them (spec #341, slice 1b): every Catalogue Warden has, whether the
// Team has it on, and its judged Controls. The Team comes from the session, never the body. The Catalogue's text is
// the rights holder's: the credit and licence go wherever it is shown (CC BY-ND 4.0).
//
// Each judged Control's Verdict, reason and evidence (slice 2b): worked out on read from the Team's Findings, Scan
// coverage and Judge Spot runs in the last 30 days, never stored.
//
// A Lead's review of a Control's Verdict (slice 3): confirmed or overridden, each a row of an append-only review log.
import { z } from "zod";
import { DecisionReason } from "./decisions.ts";
import { Asset, AssetKind, DateTime, Id, RuleId, Severity, Title } from "./finding.ts";

/**
 * The Catalogues Warden has, by id. The one place they live: the Vouch module's Catalogues and the database's check
 * constraint on `team_catalogues.catalogue` follow this list.
 */
export const CatalogueId = z.enum(["vda-isa-2027.1"]);
export type CatalogueId = z.infer<typeof CatalogueId>;

/**
 * Vouch's judgement of one Control (GLOSSARY: Verdict), worked out from the Team's Findings, Scan coverage and Judge
 * Spot runs. A worked-out Verdict is never not applicable: only a Lead's review says that (`ReviewedVerdict`).
 */
export const Verdict = z.enum(["evidenced", "partly_evidenced", "not_evidenced"]);
export type Verdict = z.infer<typeof Verdict>;

/** A Verdict as a Lead reviewed it (spec #341, slice 3): a worked-out one, or not applicable, which only a Lead says. */
export const ReviewedVerdict = z.enum([...Verdict.options, "not_applicable"]);
export type ReviewedVerdict = z.infer<typeof ReviewedVerdict>;

/**
 * Where a Control stands with its reviews: none yet; reviewed, the newest review made on the Verdict worked out now;
 * or changed since review, the Verdict worked out now differing from the one the newest review was made on.
 */
export const ReviewState = z.enum(["not_reviewed", "reviewed", "changed_since_review"]);
export type ReviewState = z.infer<typeof ReviewState>;

/**
 * Whether a Control at `state` has a review: reviewed, or changed since review, which still has its newest review. The
 * Level counts both (GLOSSARY: Audit-ready), on the server and on the Overview's Audit-ready card.
 */
export const hasReview = (state: ReviewState): boolean => state !== "not_reviewed";

/** What a review did: kept the worked-out Verdict, or put another in its place. */
export const ReviewOutcome = z.enum(["confirmed", "overridden"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/** One judged Control, its text unchanged from the Catalogue: its ref, its question and its ISO 27001 reference. */
export const CatalogueControl = z.object({
  /** The Control's number in its Catalogue, such as 1.3.3. */
  ref: z.string().min(1),
  question: z.string().min(1),
  iso_27001: z.string().min(1),
});
export type CatalogueControl = z.infer<typeof CatalogueControl>;

/**
 * One Catalogue as the Team sees it: what it is, its credit and licence, whether it is on for the Team, who set it (an
 * Admin's Clerk user id) and when (both null when no Admin ever set it, and it is off), and the Controls Vouch judges.
 * `PUT /api/vouch/catalogues/:id` answers the Catalogue it changed in this shape.
 */
export const TeamCatalogue = z.object({
  id: CatalogueId,
  name: z.string().min(1),
  /** The version's publication date. */
  date: z.iso.date(),
  credit: z.string().min(1),
  licence: z.string().min(1),
  licence_url: z.url(),
  on: z.boolean(),
  set_by: z.string().min(1).nullable(),
  set_at: z.iso.datetime().nullable(),
  /** Only the Controls Vouch gives a Verdict, in the order it shows them; the rest of the Catalogue waits. */
  controls: z.array(CatalogueControl),
});
export type TeamCatalogue = z.infer<typeof TeamCatalogue>;

/** `GET /api/vouch/catalogues`: every Catalogue Warden has, as the Team sees it. Any person in the Team reads it. */
export const CataloguesBody = z.object({ catalogues: z.array(TeamCatalogue) });
export type CataloguesBody = z.infer<typeof CataloguesBody>;

/** One of a Control's Rules, as evidence: the kind of Asset it is judged on, and how much of it was covered. */
export const ControlRuleEvidence = z.object({
  rule_id: RuleId,
  /** A `guard/` Rule is judged on Repos, a `patch/` Rule on Products. */
  asset_kind: AssetKind.extract(["repo", "product"]),
  /** The newest Scan that covered the Rule on a held Asset in the last 30 days; null when none did. */
  last_covered_at: DateTime.nullable(),
  /** The Team's held Assets of that kind the Rule covered in the last 30 days. */
  assets_covered: z.number().int().nonnegative(),
  /** The Team's Assets of that kind, held now. */
  assets_held: z.number().int().nonnegative(),
});
export type ControlRuleEvidence = z.infer<typeof ControlRuleEvidence>;

/** An Open Finding that counts against a Control, with what the dashboard needs to name it and link to it. */
export const ControlOpenFinding = z.object({
  id: Id,
  rule_id: RuleId,
  title: Title,
  severity: Severity,
  asset: Asset,
});
export type ControlOpenFinding = z.infer<typeof ControlOpenFinding>;

/** The evidence behind a Control's Verdict. */
export const ControlEvidence = z.object({
  /** Each Rule the Control maps to; none for a Control a Judge Spot run evidences. */
  rules: z.array(ControlRuleEvidence),
  /** For a Control a Judge Spot run evidences (5.2.4): the newest in the last 30 days, or null. Null for the others. */
  judge_spot_run_at: DateTime.nullable(),
  /** The Open Findings under the Control's Rules, on the Team's held Assets, by Rule then id. */
  open_findings: z.array(ControlOpenFinding),
});
export type ControlEvidence = z.infer<typeof ControlEvidence>;

/**
 * One judged Control with its worked-out Verdict, its one-line reason and the evidence behind it, and where it stands
 * with its reviews: `reviewed_verdict` is the newest review's Verdict while `review_state` is `reviewed`, and null
 * otherwise (not reviewed, or changed since review: it waits for a review of the Verdict worked out now).
 */
export const ControlVerdict = CatalogueControl.extend({
  verdict: Verdict,
  reason: z.string().min(1),
  evidence: ControlEvidence,
  review_state: ReviewState,
  reviewed_verdict: ReviewedVerdict.nullable(),
});
export type ControlVerdict = z.infer<typeof ControlVerdict>;

/**
 * One row of the review log, as the API answers it: the Verdict the server worked out when it was written, what the
 * Lead did and the Verdict they gave (the worked-out one on a confirm), their reason (null on a confirm without one),
 * who reviewed (a Lead's or an Admin's Clerk user id, from the session) and when. Never changed.
 */
export const ControlReview = z.object({
  id: Id,
  worked_out_verdict: Verdict,
  outcome: ReviewOutcome,
  verdict: ReviewedVerdict,
  reason: DecisionReason.nullable(),
  reviewed_by: Id,
  reviewed_at: DateTime,
});
export type ControlReview = z.infer<typeof ControlReview>;

/**
 * `GET /api/vouch/catalogues/:id/controls/:ref`, and `POST .../controls/:ref/reviews`' answer: one Control as the list
 * shows it, with its reviews, newest first.
 */
export const ControlDetail = ControlVerdict.extend({ reviews: z.array(ControlReview) });
export type ControlDetail = z.infer<typeof ControlDetail>;

/**
 * `POST /api/vouch/catalogues/:id/controls/:ref/reviews`' body (a Lead or an Admin): confirm the worked-out Verdict,
 * with a reason if they like, or override it to another Verdict with a reason. Strict: who reviewed, the worked-out
 * Verdict and the Team are the server's, never the body's.
 */
export const ReviewBody = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("confirm"), reason: DecisionReason.optional() }),
  z.strictObject({
    outcome: z.literal("override"),
    verdict: ReviewedVerdict,
    reason: DecisionReason,
  }),
]);
export type ReviewBody = z.infer<typeof ReviewBody>;

/**
 * `GET /api/vouch/catalogues/:id/controls`: the Catalogue's judged Controls with their Verdicts, in the order it shows
 * them, and whether the Team has it on. Any person in the Team reads it. `GET .../controls/:ref` answers one
 * `ControlDetail`.
 */
export const ControlsBody = z.object({
  catalogue: CatalogueId,
  on: z.boolean(),
  controls: z.array(ControlVerdict),
});
export type ControlsBody = z.infer<typeof ControlsBody>;

/**
 * "Are we ready for the audit?" (spec #341, slice 4): yes, every judged Control of every Catalogue the Team has on is
 * reviewed with no Gap; not yet, a Control waits for a review or is a Gap; or no Catalogue is on to be ready for.
 */
export const ReadyForAudit = z.enum(["yes", "not_yet", "no_catalogue"]);
export type ReadyForAudit = z.infer<typeof ReadyForAudit>;

/**
 * One judged Control of a Catalogue the Team has on, as the Overview answers it: its Verdict worked out now and its
 * review state, as `ControlVerdict` has them, and whether it is a Gap (GLOSSARY: Gap): reviewed, at not evidenced or
 * partly evidenced. A Control waiting for a review (not reviewed, or changed since review) is never a Gap.
 */
export const AuditControl = z.object({
  catalogue: CatalogueId,
  ref: CatalogueControl.shape.ref,
  question: CatalogueControl.shape.question,
  verdict: Verdict,
  review_state: ReviewState,
  reviewed_verdict: ReviewedVerdict.nullable(),
  gap: z.boolean(),
});
export type AuditControl = z.infer<typeof AuditControl>;

/**
 * One Catalogue the Team has on, as the Overview answers it (spec #341, slice 6): what it is, and its credit and
 * licence, which go wherever its Controls' text is shown. `TeamCatalogue`'s fields of the same names.
 */
export const AuditCatalogue = TeamCatalogue.pick({
  id: true,
  name: true,
  date: true,
  credit: true,
  licence: true,
  licence_url: true,
});
export type AuditCatalogue = z.infer<typeof AuditCatalogue>;

/**
 * `GET /api/overview`'s `audit`: the answer, its Gaps, the Controls waiting for a review, each Catalogue the Team has
 * on, and one row per judged Control of each one, the Catalogues in the order `GET /api/vouch/catalogues` lists them
 * (`controls` groups them in the same order) and each one's Controls in the order it shows them. Worked out on read,
 * never stored.
 */
export const AuditAnswer = z.object({
  answer: ReadyForAudit,
  gaps: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  /** None with `no_catalogue`. */
  catalogues: z.array(AuditCatalogue),
  controls: z.array(AuditControl),
});
export type AuditAnswer = z.infer<typeof AuditAnswer>;

/** `PUT /api/vouch/catalogues/:id`'s body (Admin): turn the Catalogue on or off for the Team. Nothing else. */
export const CatalogueSwitchBody = z.strictObject({ on: z.boolean() });
export type CatalogueSwitchBody = z.infer<typeof CatalogueSwitchBody>;
