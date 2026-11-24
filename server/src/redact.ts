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

/** A system error's fields worth logging (a refused connection's code, address and port). Anything else an error
 * carries, such as a client's config, is left out. */
const ERROR_FIELDS = ["code", "errno", "syscall", "address", "port"] as const;

function redactString(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/**
 * A copy of `value` safe to log: strings masked, secret headers dropped, errors reduced to their name, message,
 * stack, system fields, cause and inner errors. `ancestors` holds the objects above this one, so only a real cycle
 * is cut; an object that appears twice is read both times.
 */
export function redact(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    return value instanceof Error ? redactError(value, ancestors) : redactObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function redactError(error: Error, ancestors: Set<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
    stack: error.stack === undefined ? undefined : redactString(error.stack),
  };
  const fields = error as Error & Partial<Record<(typeof ERROR_FIELDS)[number], unknown>>;
  for (const field of ERROR_FIELDS) {
    const item = fields[field];
    if (typeof item === "string" || typeof item === "number") out[field] = redact(item, ancestors);
  }
  if (error.cause !== undefined) out.cause = redact(error.cause, ancestors);
  if (error instanceof AggregateError) out.errors = redact(error.errors, ancestors);
  return out;
}

function redactObject(value: object, ancestors: Set<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, ancestors));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, ancestors),
    ]),
  );
}
