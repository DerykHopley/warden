// "Are we ready for the audit?" as GET /api/overview's `audit` answers it (spec #341): no Catalogue on, or ISA2027 on
// with its four judged Controls, each a valid `AuditControl`, so the page's parse takes them; and one Control as GET
// /api/vouch/catalogues/:id/controls/:ref answers it, a valid `ControlDetail`.
import type {
  AuditAnswer,
  AuditCatalogue,
  AuditControl,
  ControlDetail,
  OverviewBody,
} from "@warden/contracts";

/** The answer for a Team with no Catalogue on. */
export const NO_CATALOGUE: AuditAnswer = {
  answer: "no_catalogue",
  gaps: 0,
  waiting: 0,
  catalogues: [],
  controls: [],
};

/** VDA ISA 2027.1 as the answer gives it, with its credit and licence. */
export const ISA: AuditCatalogue = {
  id: "vda-isa-2027.1",
  name: "VDA ISA 2027.1",
  date: "2026-09-30",
  credit: "© 2026 ENX Association.",
  licence: "CC BY-ND 4.0",
  licence_url: "https://creativecommons.org/licenses/by-nd/4.0/",
};

/** ISA2027's judged Controls, in the order the server gives them. */
export const ISA_REFS = ["1.3.3", "1.3.4", "4.1.3", "5.2.4"] as const;

/** ISA2027's Control `ref`, not reviewed at not evidenced unless `fields` says otherwise. */
export const auditRow = (ref: string, fields: Partial<AuditControl> = {}): AuditControl => ({
  catalogue: ISA.id,
  ref,
  question: `Question ${ref}?`,
  verdict: "not_evidenced",
  review_state: "not_reviewed",
  reviewed_verdict: null,
  gap: false,
  ...fields,
});

/** A Control reviewed at `verdict`, as worked out now. */
export const reviewedRow = (ref: string, verdict: AuditControl["verdict"] = "evidenced") =>
  auditRow(ref, { verdict, review_state: "reviewed", reviewed_verdict: verdict });

/** ISA2027 on with nothing reviewed (not yet, four waiting), unless `fields` says otherwise. */
export const isaOn = (fields: Partial<AuditAnswer> = {}): AuditAnswer => ({
  answer: "not_yet",
  gaps: 0,
  waiting: ISA_REFS.length,
  catalogues: [ISA],
  controls: ISA_REFS.map((ref) => auditRow(ref)),
  ...fields,
});

/** GET /api/overview's answer for `team` at Quick, with ISA2027 on as `isaOn` gives it unless `fields` says otherwise. */
export const overviewBody = (team: string, fields: Partial<OverviewBody> = {}): OverviewBody => ({
  team,
  level: "quick",
  audit: isaOn(),
  last_scan_at: "2026-11-24T09:14:00Z",
  has_findings: true,
  period_days: 30,
  agent_sessions: { hook_active: false, judged: 0, needs_human_review: 0 },
  open_at_start: 0,
  open_now: 1,
  fix_rate: { fixed: 0, of: 1 },
  ...fields,
});

/**
 * ISA2027's Control `ref` as its card reads it: not reviewed at not evidenced, one guard Rule never covered on 1 Repo,
 * no Open Finding and no review, unless `fields` says otherwise.
 */
export const controlDetail = (ref: string, fields: Partial<ControlDetail> = {}): ControlDetail => ({
  ref,
  question: `Question ${ref}?`,
  iso_27001: "A.5.1",
  verdict: "not_evidenced",
  reason: "No Scan covered it in the last 30 days",
  evidence: {
    rules: [
      {
        rule_id: "guard/unapproved-ai-tool",
        asset_kind: "repo",
        last_covered_at: null,
        assets_covered: 0,
        assets_held: 1,
      },
    ],
    judge_spot_run_at: null,
    open_findings: [],
  },
  review_state: "not_reviewed",
  reviewed_verdict: null,
  reviews: [],
  ...fields,
});
