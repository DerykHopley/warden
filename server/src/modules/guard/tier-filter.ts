// What an Agent event keeps at its Team's Privacy tier (docs/data.md, "The Privacy tier"): an allow-list of Claude
// Code's hook fields per tier, so a field Claude Code adds later is never stored by default. Metadata keeps short
// strings naming the event; Details adds the folder, the transcript and the tool's commands, paths and URLs; Content
// adds the tool's whole input and output, errors and prompts. `redactEvent` then masks what's kept (#184).
import type { PrivacyTier } from "@warden/contracts";
import type { JsonValue } from "./agent-sessions.ts";

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

/** Details' own string fields: the session's folder and its transcript's path. */
const DETAILS_STRINGS = ["cwd", "transcript_path"] as const;

/**
 * The `tool_input` keys Details keeps when their values are strings: commands, file paths and URLs. Never written or
 * fetched content (`content`, `old_string`, `new_string`, `edits`, `new_source`, a tool's `prompt`), nor an MCP
 * tool's other keys.
 */
const DETAILS_TOOL_INPUT = [
  "command",
  "description",
  "file_path",
  "path",
  "notebook_path",
  "url",
  "pattern",
  "glob",
] as const;

/** Content's own string fields. */
const CONTENT_STRINGS = ["error", "prompt"] as const;

/** Content's fields kept whatever their JSON type. */
const CONTENT_VALUES = ["tool_input", "tool_response"] as const;

/** The longest value a Metadata field may have. */
const MAX_VALUE_LENGTH = 256;

/** The deepest a kept field may nest, counting each object and array: past it, the field is dropped whole. */
const MAX_FIELD_DEPTH = 64;

/**
 * Whether a Metadata field's value is kept: a string of at most 256 characters that Postgres can hold in jsonb, so
 * with no NUL and no lone surrogate (either would refuse the whole event).
 */
const keptMetadata = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_VALUE_LENGTH &&
  !value.includes("\u0000") &&
  value.isWellFormed();

/** `text` as Postgres's jsonb holds it: each NUL and each lone surrogate becomes U+FFFD, the rest kept. */
const storable = (text: string) => text.toWellFormed().replaceAll("\u0000", "�");

/**
 * A storable copy of a JSON value, or undefined when it nests deeper than `levels` objects and arrays. Objects are
 * built with `Object.fromEntries`, so a `__proto__` key stays an ordinary key and never sets a prototype.
 */
function bounded(value: unknown, levels = MAX_FIELD_DEPTH): JsonValue | undefined {
  if (typeof value === "string") return storable(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object" || levels === 0) return undefined;
  const entries: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    const copy = bounded(item, levels - 1);
    if (copy === undefined) return undefined;
    entries.push([storable(key), copy]);
  }
  return Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `from`'s own field `name`, or undefined when it has none: a field on its prototype is never read. */
const ownField = (from: Record<string, unknown>, name: string): unknown =>
  Object.hasOwn(from, name) ? from[name] : undefined;

/** Each named string field of `from`, storable; a field that's missing or isn't a string is left out. */
function strings(from: Record<string, unknown>, names: readonly string[]): [string, string][] {
  return names.flatMap((name) => {
    const value = ownField(from, name);
    return typeof value === "string" ? [[name, storable(value)] as [string, string]] : [];
  });
}

/** Details' `tool_input`: its listed string keys, or undefined when it isn't an object or keeps none. */
function detailsToolInput(toolInput: unknown): Record<string, string> | undefined {
  if (!isObject(toolInput)) return undefined;
  const kept = strings(toolInput, DETAILS_TOOL_INPUT);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/** The fields of `event` that `tier` keeps; every other field, and a kept one with a value it refuses, is dropped. */
export function filterToTier(
  event: Record<string, unknown>,
  tier: PrivacyTier,
): Record<string, JsonValue> {
  const kept: Record<string, JsonValue> = {};
  for (const field of METADATA) {
    const value = ownField(event, field);
    if (keptMetadata(value)) kept[field] = value;
  }
  if (tier === "metadata") return kept;

  Object.assign(kept, Object.fromEntries(strings(event, DETAILS_STRINGS)));
  if (tier === "details") {
    const toolInput = detailsToolInput(ownField(event, "tool_input"));
    if (toolInput !== undefined) kept.tool_input = toolInput;
    return kept;
  }

  for (const field of CONTENT_VALUES) {
    const value = bounded(ownField(event, field));
    if (value !== undefined) kept[field] = value;
  }
  Object.assign(kept, Object.fromEntries(strings(event, CONTENT_STRINGS)));
  return kept;
}
