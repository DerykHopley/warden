// Reading a repo's JSON config file (a Claude Code settings file, a `.mcp.json`) as Claude Code reads it, so a Rule
// sees what the agent would apply: a file that isn't valid JSON holds nothing.

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A config file's top-level object, and the text it was parsed from (for `valueLines`). A leading byte order mark is
 * dropped first. Undefined for text that still isn't valid JSON, and for a top level that isn't an object.
 */
export function readJsonObject(
  raw: string,
): { text: string; config: Record<string, unknown> } | undefined {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isObject(parsed) ? { text, config: parsed } : undefined;
}
