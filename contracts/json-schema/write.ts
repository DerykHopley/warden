// `pnpm --filter @warden/contracts json-schema`: writes the JSON Schema files next to this script.
import { writeFileSync } from "node:fs";
import { jsonSchemaDir, renderJsonSchemas } from "./render.ts";

for (const [file, content] of await renderJsonSchemas()) {
  writeFileSync(new URL(file, jsonSchemaDir), content);
  console.log(`wrote json-schema/${file}`);
}
