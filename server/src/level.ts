// A Team's Level on the journey (GLOSSARY.md), read from what it has set up: the one place the server decides it.
import type { Level } from "@warden/contracts";

/**
 * The Team's Level. Standard needs the agent hook and the Judge (the Guard spec); Audit-ready needs Vouch's Policy and
 * evidence (the Vouch spec). Neither exists yet, so every Team is Quick: those specs add their rules here.
 */
export function teamLevel(): Level {
  return "quick";
}
