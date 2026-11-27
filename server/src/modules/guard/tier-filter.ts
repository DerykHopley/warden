// What an Agent event keeps at its Team's Privacy tier (docs/data.md, "The Privacy tier"): an allow-list of Claude
// Code's top-level hook fields, so a field Claude Code adds later is never stored by default. In this slice every tier
// keeps only the Metadata list; #184 adds the Details and Content lists, with redaction, at this same call.
import type { PrivacyTier } from "@warden/contracts";

/** Claude Code's names (its hooks reference): the event, the tool, the mode and agent, and SessionStart/End's own. */
const METADATA = [
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "permission_mode",
  "agent_id",
  "agent_type",
  "source",
  "reason",
  "model",
] as const;

const KEPT: Record<PrivacyTier, readonly string[]> = {
  metadata: METADATA,
  details: METADATA,
  content: METADATA,
};

/** The longest value a kept field may have. */
const MAX_VALUE_LENGTH = 256;

/**
 * Whether a field's value is kept: a string of at most 256 characters that Postgres can hold in jsonb, so with no NUL
 * and no lone surrogate (either would refuse the whole event).
 */
const keptValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_VALUE_LENGTH &&
  !value.includes("\u0000") &&
  value.isWellFormed();

/** The fields of `event` that `tier` keeps; every other field, and a kept one with any other value, is dropped. */
export function filterToTier(
  event: Record<string, unknown>,
  tier: PrivacyTier,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const field of KEPT[tier]) {
    const value = Object.hasOwn(event, field) ? event[field] : undefined;
    if (keptValue(value)) kept[field] = value;
  }
  return kept;
}
