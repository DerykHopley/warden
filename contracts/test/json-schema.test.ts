import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchemaDir, renderJsonSchemas } from "../json-schema/render.ts";

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
});
