import { expect } from "vitest";
import type { z } from "zod";

/**
 * Asserts the schema refuses the value with an issue that names the field: either the issue's path ends with it,
 * or (for an unrecognised key) the issue lists it.
 */
export function expectRefused(schema: z.ZodType, value: unknown, field: string) {
  const result = schema.safeParse(value);
  expect(result.success, `expected a refusal naming "${field}"`).toBe(false);
  const issues = result.error?.issues ?? [];
  const names = issues.flatMap((issue) => [
    ...issue.path.map(String),
    ...("keys" in issue && Array.isArray(issue.keys) ? issue.keys.map(String) : []),
  ]);
  expect(names, JSON.stringify(issues)).toContain(field);
}
