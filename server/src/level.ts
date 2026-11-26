// A Team's Level on the journey (GLOSSARY.md), read from what it has set up: the one place the server decides it.
import type { Level } from "@warden/contracts";

/** What the Level reads of a Team: whether it is Audit-ready (Vouch: a Catalogue on, every Control reviewed). */
export type TeamFacts = { auditReady: boolean };

/**
 * The Team's Level from its `facts`. Audit-ready once Vouch says so; otherwise Quick. Standard needs the agent hook and
 * the Judge (#225 adds its rule here); Audit-ready doesn't wait for it, as no Standard rule exists yet.
 */
export function teamLevel(facts: TeamFacts): Level {
  return facts.auditReady ? "audit_ready" : "quick";
}
