// Redaction on arrival (spec #225, slice 3, #184; threat H8): what the tier filter kept of an Agent event is redacted
// before it's stored, at every Privacy tier. Every string and every object key, at any depth, loses the developer's
// home folder name, Guard's nine secret types and the log redactor's patterns, so neither a secret nor the person's
// name reaches `agent_events`.
import { redactString } from "../../redact.ts";
import type { JsonValue } from "./agent-sessions.ts";
import { maskSecrets } from "./secrets.ts";

/** A path separator: `/` or `\`, or either JSON-escaped (`\/`, `\\`), as a command holding JSON text has them. */
const SEP = String.raw`(?:\\\\|\\/|/|\\)`;

/**
 * A user name: one path segment, up to the next separator, whitespace, quote, shell operator or the string's end.
 * None of these can be in a user name on Linux, macOS or Windows, so the name is masked whole.
 */
const NAME = String.raw`[^/\\\s"'\x60;:,|&<>()\[\]{}=]+`;

/**
 * A home folder, with its user name: `/home/<name>`, `/var/home/<name>` and `/Users/<name>`, not inside a longer
 * path segment or a URL's path, and `<drive>:\Users\<name>` with the drive letter and `Users` in either case.
 */
const HOME_FOLDER = new RegExp(
  String.raw`(?<![\w.~-])(?:${SEP}var)?${SEP}(?:home|Users)${SEP}${NAME}|(?<![A-Za-z0-9])[A-Za-z]:${SEP}[Uu][Ss][Ee][Rr][Ss]${SEP}${NAME}`,
  "g",
);

/**
 * Claude Code's encoded project folder (the one right after `.claude/projects/`) when it starts with an encoded
 * home folder: the person's name can't be split from the project's, so the folder is masked whole.
 */
const ENCODED_PROJECT = new RegExp(
  String.raw`(\.claude${SEP}projects${SEP})(?:-home-|-var-home-|-Users-|[A-Za-z]--Users-)${NAME}`,
  "g",
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
