// "Are we ready for the audit?" as GET /api/overview's `audit` answers it (spec #341): no Catalogue on, or ISA2027 on
// with its four judged Controls, each a valid `AuditControl`, so the page's parse takes them.
import type { AuditAnswer, AuditCatalogue, AuditControl } from "@warden/contracts";

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
