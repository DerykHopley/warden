// Before results are committed: replaces this machine's path to the spike with its path in the repo, and the
// signed-in gcloud account's email with a placeholder. Run: node spikes/long-work/tidy-results.ts <email>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const spikeDir = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const results = join(spikeDir, "results");
const email = process.argv[2];
if (!email) throw new Error("usage: node tidy-results.ts <gcloud account email>");

for (const name of readdirSync(results)) {
  const file = join(results, name);
  const before = readFileSync(file, "utf8");
  const after = before
    .split(spikeDir)
    .join("spikes/long-work")
    .split(email)
    .join("<owner's gcloud account>");
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`tidied ${name}`);
  }
}
