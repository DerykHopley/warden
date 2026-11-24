// Renders the published JSON Schema files from the zod schemas, formatted as prettier would write them. `write.ts`
// writes them; a contracts test fails when the committed files differ.
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { z } from "zod";
import {
  contractsRegistry,
  Finding,
  Observation,
  ReconcileCase,
  Scan,
  SpotRun,
} from "../src/index.ts";

export const jsonSchemaDir = new URL("./", import.meta.url);

const published = { Finding, Observation, Scan, SpotRun, ReconcileCase };

/** File name to content, for every published schema. */
export async function renderJsonSchemas(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [name, schema] of Object.entries(published)) {
    const file = `${name}.json`;
    // The registry turns every named schema (Asset, Location, Evidence, …) into a `$defs` entry of that name.
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", metadata: contractsRegistry });
    const filepath = fileURLToPath(new URL(file, jsonSchemaDir));
    const options = (await prettier.resolveConfig(filepath)) ?? {};
    files.set(file, await prettier.format(JSON.stringify(json), { ...options, filepath }));
  }
  return files;
}
