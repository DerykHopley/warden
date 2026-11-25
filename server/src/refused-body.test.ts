import { describe, expect, it } from "vitest";
import { z } from "zod";
import { refusedBody } from "./refused-body.ts";

function refusal(schema: z.ZodType, input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected the schema to refuse the input");
  return parsed.error;
}

describe("refusedBody", () => {
  it("joins a nested field's path with dots", () => {
    const schema = z.object({ a: z.object({ b: z.string() }) });

    expect(refusedBody(refusal(schema, { a: { b: 1 } }))).toMatch(/^a\.b: /);
  });

  it("names the body when the input isn't an object", () => {
    const schema = z.object({ name: z.string() });

    expect(refusedBody(refusal(schema, "not an object"))).toMatch(/^body: /);
  });

  it("answers every issue, in the schema's order, joined by a semicolon", () => {
    const schema = z.object({ first: z.string(), second: z.number() });
    const error = refusal(schema, { first: 1, second: "two" });

    expect(refusedBody(error)).toBe(
      `first: ${error.issues[0]?.message}; second: ${error.issues[1]?.message}`,
    );
  });
});
