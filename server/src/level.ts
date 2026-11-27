// A Team's Level on the journey (GLOSSARY.md), read from what it has set up: the one place the server decides it.
import { hasReview, type AuditAnswer, type Level, type ReviewState } from "@warden/contracts";

/** What the Level reads of a Team: whether it is Audit-ready (Vouch: a Catalogue on, every Control reviewed). */
export type TeamFacts = { auditReady: boolean };

/**
 * The Team's Level from its `facts`. Audit-ready once Vouch says so; otherwise Quick. Standard needs the agent hook and
 * the Judge (#225 adds its rule here); Audit-ready doesn't wait for it, as no Standard rule exists yet.
 */
export function teamLevel(facts: TeamFacts): Level {
  return facts.auditReady ? "audit_ready" : "quick";
}

/**
 * Audit-ready (GLOSSARY), from the review states of each Catalogue the Team has on, one list per Catalogue: at least
 * one on, each judging at least one Control, and none of them not reviewed. A Control changed since review has a
 * review, so it counts, with Gaps or without. Vouch's `isAuditReady` reads it from its switches and newest reviews, and
 * the Overview from Vouch's answer (`auditReadyOfAnswer`).
 */
export function auditReadyOf(on: readonly (readonly ReviewState[])[]): boolean {
  return on.length > 0 && on.every((states) => states.length > 0 && states.every(hasReview));
}

/**
 * Audit-ready from Vouch's answer in hand, by `auditReadyOf`: never with no Catalogue on; otherwise once no row of any
 * Catalogue it lists waits for its first review. Each listed Catalogue starts with no row, so one on that judges no
 * Control keeps the Team from being ready.
 */
export function auditReadyOfAnswer(audit: AuditAnswer): boolean {
  if (audit.answer === "no_catalogue") return false;
  const byCatalogue = new Map<string, ReviewState[]>(audit.catalogues.map(({ id }) => [id, []]));
  for (const { catalogue, review_state } of audit.controls) {
    byCatalogue.get(catalogue)?.push(review_state);
  }
  return auditReadyOf([...byCatalogue.values()]);
}
