// Redaction on arrival (spec #225, slice 3, #184; threat H8): what the tier filter kept of an Agent event is redacted
// before it's stored, at every Privacy tier. Every string and every object key, at any depth, loses the developer's
// home folder name, Guard's nine secret types and the log redactor's patterns, so neither a secret nor the person's
// name reaches `agent_events`.
import { redactString } from "../../redact.ts";
import type { JsonValue } from "./agent-sessions.ts";
import { maskSecrets } from "./secrets.ts";

/**
 * A run of path separators: `/` and `\` in any mix, so a doubled one (`//`) and a JSON-escaped one (`\/`, `\\`), as
 * a command holding JSON text has them, are each one separator. One character class, so a long run never backtracks
 * more than once.
 */
const SEP = String.raw`[/\\]+`;

/**
 * A user name: one path segment, up to the next separator, whitespace, quote, shell operator or the string's end.
 * None of these can be in a user name on Linux, macOS or Windows, so the name is masked whole.
 */
const NAME = String.raw`[^/\\\s"'\x60;:,|&<>()\[\]{}=]+`;

/**
 * A home folder, with its user name, in any case (macOS ignores it), wherever it starts, a URL's path included (the
 * person's name is masked there too): `/home/<name>`, `/var/home/<name>` and `/Users/<name>`, also after git-bash's
 * `/c` or WSL's `/mnt/c`, and `<drive>:\Users\<name>`, also after a long path's `\\?\`. Those two drive letters
 * follow a `/`, so a JSON-escaped `\n` before a path stays. A match starts only at a run of separators' first one, or
 * at a drive letter, so a long run is scanned once.
 */
const DRIVE_FOLDER = String.raw`[/\\]*/[a-z]`;
const HOME_FOLDER = new RegExp(
  String.raw`(?<![/\\])(?:${SEP}var|(?:${SEP}mnt)?${DRIVE_FOLDER})?${SEP}(?:home|users)${SEP}${NAME}` +
    String.raw`|(?<![a-z0-9])(?:(?<![/\\])${SEP}\?${SEP})?[a-z]:${SEP}users${SEP}${NAME}`,
  "gi",
);

/**
 * Claude Code's encoded project folder (the one right after `.claude/projects/`) when it starts with an encoded
 * home folder, in any case: the person's name can't be split from the project's, so the folder is masked whole.
 */
const ENCODED_PROJECT = new RegExp(
  String.raw`(\.claude${SEP}projects${SEP})(?:-home-|-var-home-|-Users-|[a-z]--Users-)${NAME}`,
  "gi",
);

/** `text` redacted: the home folder becomes `~`, then Guard's secrets are masked, then the log redactor's patterns. */
function redactText(text: string): string {
  const homeless = text.replace(HOME_FOLDER, "~").replace(ENCODED_PROJECT, "$1~");
  return redactString(maskSecrets(homeless));
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactValue);
  // `Object.fromEntries` keeps a `__proto__` key an ordinary key, so the copy's prototype is always Object.prototype.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redactText(key), redactValue(item)]),
  );
}

/**
 * A redacted copy of an event's kept fields (`filterToTier`'s output, so at most 64 levels deep): every string value
 * and every object key, at any depth, with the home folder turned into `~`, Guard's secrets masked and the log
 * redactor's patterns applied, in that order.
 */
export function redactEvent(fields: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactValue(fields) as Record<string, JsonValue>;
}
