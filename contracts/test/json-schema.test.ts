import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchemaDir, renderJsonSchemas } from "../json-schema/render.ts";
import { AWS_KEY } from "./secret-fixtures.ts";

describe("the committed JSON Schema files", () => {
  it("are one per published schema", async () => {
    const rendered = await renderJsonSchemas();
    expect([...rendered.keys()]).toEqual([
      "Finding.json",
      "Observation.json",
      "Scan.json",
      "SpotRun.json",
      "ReconcileCase.json",
    ]);
  });

  it("match what the json-schema script writes now", async () => {
    for (const [file, content] of await renderJsonSchemas()) {
      let committed = "";
      try {
        committed = readFileSync(new URL(file, jsonSchemaDir), "utf8");
      } catch {
        // A missing file reads as empty, so the message below names the script.
      }
      expect(
        committed,
        `json-schema/${file} is out of date: run \`pnpm --filter @warden/contracts json-schema\``,
      ).toBe(content);
    }
  });

  it("describe the shapes: a Finding's fields, and no field outside them", async () => {
    const file = JSON.parse((await renderJsonSchemas()).get("Finding.json")!);
    expect(file.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(file.$ref).toBe("#/$defs/Finding");
    expect(file.$defs.Finding.additionalProperties).toBe(false);
    expect(file.$defs.Finding.required).toContain("fingerprint");
    expect(file.$defs.Location.oneOf).toHaveLength(4);
  });

  /** Whitespace beyond ASCII that the not-blank rule counts as blank: no-break space, ideographic space, BOM. */
  const UNICODE_BLANKS = [
    [0xa0],
    [0x3000],
    [0xfeff],
    [0x2028],
    [0x20, 0xa0, 0xfeff, 0x2009, 0x20],
  ].map((points) => String.fromCodePoint(...points));

  // A reader without zod (the Rust app) gets the mask and path rules from the patterns alone.
  describe("publish the mask and path rules as patterns", () => {
    type StringSchema = { pattern?: string; allOf?: { pattern?: string }[] };
    /** Whether a string passes every pattern the schema publishes, as a JSON Schema validator reads them. */
    const passes = (schema: StringSchema, value: string) => {
      const patterns = [schema.pattern, ...(schema.allOf ?? []).map((part) => part.pattern)];
      return patterns.every(
        (pattern) => pattern === undefined || new RegExp(pattern, "u").test(value),
      );
    };

    it("refuses an unmasked secret, and a mask showing 5 characters", async () => {
      const file = JSON.parse((await renderJsonSchemas()).get("Finding.json")!);
      const mask = file.$defs.SecretEvidence.properties.mask as StringSchema;
      expect(passes(mask, "AKIA****************")).toBe(true);
      expect(passes(mask, "****")).toBe(true);
      expect(passes(mask, AWS_KEY)).toBe(false);
      expect(passes(mask, "AKIAB***")).toBe(false);
      expect(passes(mask, "A*K*I*A*B")).toBe(false);
    });

    it("refuses a title, an accepted_reason and a decision's reason of only whitespace", async () => {
      const rendered = await renderJsonSchemas();
      const finding = JSON.parse(rendered.get("Finding.json")!).$defs.Finding.properties;
      const observation = JSON.parse(rendered.get("Observation.json")!).$defs.Observation
        .properties;
      const reconcileCase = JSON.parse(rendered.get("ReconcileCase.json")!);
      const decision = (
        reconcileCase.$defs.ReconcileCase.properties.steps.items.oneOf as {
          properties: Record<string, StringSchema & { const?: string }>;
        }[]
      ).find((step) => step.properties.reason)!.properties;
      const acceptedReason = (finding.accepted_reason.anyOf as StringSchema[]).find(
        (part) => (part as { type?: string }).type === "string",
      )!;
      for (const schema of [finding.title, observation.title, acceptedReason, decision.reason]) {
        for (const blank of [" ", "\t", "\n", " \t\r\n ", ...UNICODE_BLANKS]) {
          expect(passes(schema, blank), JSON.stringify(blank)).toBe(false);
        }
        expect(passes(schema, String.fromCodePoint(0xa0, 0xe9, 0xfeff))).toBe(true);
        expect(passes(schema, " x ")).toBe(true);
      }
    });

    // `\s` differs between regex engines (Rust's leaves out U+FEFF), so the rule names its characters.
    it("spell the not-blank rule as an explicit character class, not \\s", async () => {
      const observation = JSON.parse((await renderJsonSchemas()).get("Observation.json")!).$defs
        .Observation.properties;
      const pattern = (observation.title as StringSchema).pattern!;
      expect(pattern).toMatch(/^\[\^.*\]$/);
      expect(pattern).not.toMatch(/\\[sS]/);
    });

    it("refuses an absolute path and the other spellings the zod schema refuses", async () => {
      const file = JSON.parse((await renderJsonSchemas()).get("Finding.json")!);
      const fileLocation = (
        file.$defs.Location.oneOf as { properties: Record<string, StringSchema> }[]
      )
        .map((variant) => variant.properties)
        .find((properties) => properties.path)!;
      for (const ok of [".claude/settings.json", "config/..hidden/.env..bak", "C:notes.txt", "a"]) {
        expect(passes(fileLocation.path!, ok), ok).toBe(true);
      }
      for (const bad of [
        "/etc/passwd",
        "C:/Users/dev/.env",
        "c:\\Users",
        "../outside",
        "a/../b",
        "./a",
        "a/./b",
        "a//b",
        "a/",
        "a\\b",
        "..",
        ".",
      ]) {
        expect(passes(fileLocation.path!, bad), bad).toBe(false);
      }
    });
  });
});
