// Every log line passes through here, so a secret can't reach Cloud Logging by a message, a field or an error's stack.

const MASK = "***";

/** Headers never logged, whatever object they turn up in. */
const SECRET_KEYS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/** Each shape a secret takes inside a string, with what it becomes. Order matters: a URL's password before its query. */
const PATTERNS: [RegExp, string][] = [
  [/\bsk_(test|live)_[A-Za-z0-9]+/g, `sk_$1_${MASK}`],
  [/\bBearer\s+[^\s"',;]+/gi, `Bearer ${MASK}`],
  [/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, MASK],
  [/(postgres(?:ql)?:\/\/[^:/@\s]*:)[^@\s]*@/gi, `$1${MASK}@`],
  [/([?&][^=&#\s?]+=)[^&#\s"']*/g, `$1${MASK}`],
];

export function redactString(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** A copy of `value` safe to log: strings masked, secret headers dropped, errors reduced to name, message and stack. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const error: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    };
    if (value.cause !== undefined) error.cause = redact(value.cause, seen);
    return error;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, seen),
    ]),
  );
}
