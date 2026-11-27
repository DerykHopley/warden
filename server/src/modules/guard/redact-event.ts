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

/** What ends a path segment: whitespace, a quote, a shell operator, and a URL's `?`, `#`, `&` and `=`. */
const SEGMENT_END = String.raw`\s"'\x60;:,|&<>()\[\]{}=?#`;

/**
 * A user name: one path segment, up to the next separator, a segment's end or the string's end. None of these can be
 * in a user name on Linux, macOS or Windows, so the name is masked whole, and a URL's query after it (`?token=…`)
 * stays for the log redactor to mask.
 */
const NAME = String.raw`[^/\\${SEGMENT_END}]+`;

/**
 * Git-bash's `/c` at a path's start (after the string's start or a segment's end, never after a folder, so
 * `/srv/a/home/<name>` keeps its `/a`), or WSL's `/mnt/c`. The drive letter follows a `/`, so a JSON-escaped `\n`
 * before a path stays.
 */
const DRIVE_FOLDER = String.raw`${SEP}mnt[/\\]*/[a-z]|(?<![^${SEGMENT_END}])[/\\]*/[a-z]`;

/**
 * A home folder, with its user name, in any case (macOS ignores it), wherever it starts, a URL's path included (the
 * person's name is masked there too): `/home/<name>`, `/var/home/<name>` and `/Users/<name>`, also after git-bash's
 * `/c` or WSL's `/mnt/c`, and `<drive>:\Users\<name>`, also after a long path's `\\?\`. A match starts only at a run
 * of separators' first one, or at a drive letter, so a long run is scanned once.
 */
const HOME_FOLDER = new RegExp(
  String.raw`(?<![/\\])(?:${SEP}var|${DRIVE_FOLDER})?${SEP}(?:home|users)${SEP}${NAME}` +
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

/**
 * `value`'s keys redacted, each kept apart: a key that redacts to one already taken (`/home/alice/a` and
 * `/home/bob/a` both become `~/a`) is numbered, `~/a (2)`, then `~/a (3)`, so no value is lost (#435). Each text's
 * next number is remembered, so many keys masking alike are numbered in one pass.
 */
function distinctKeys(keys: string[]): string[] {
  const taken = new Set<string>();
  const nextNumber = new Map<string, number>();
  return keys.map((key) => {
    let distinct = redactText(key);
    if (taken.has(distinct)) {
      let n = nextNumber.get(distinct) ?? 2;
      while (taken.has(`${distinct} (${n})`)) n++;
      nextNumber.set(distinct, n + 1);
      distinct = `${distinct} (${n})`;
    }
    taken.add(distinct);
    return distinct;
  });
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactValue);
  const entries = Object.entries(value);
  const keys = distinctKeys(entries.map(([key]) => key));
  // `Object.fromEntries` keeps a `__proto__` key an ordinary key, so the copy's prototype is always Object.prototype.
  return Object.fromEntries(entries.map(([, item], i) => [keys[i], redactValue(item)]));
}

/**
 * A redacted copy of an event's kept fields (`filterToTier`'s output, so at most 64 levels deep): every string value
 * and every object key, at any depth, with the home folder turned into `~`, Guard's secrets masked and the log
 * redactor's patterns applied, in that order.
 */
export function redactEvent(fields: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactValue(fields) as Record<string, JsonValue>;
}
