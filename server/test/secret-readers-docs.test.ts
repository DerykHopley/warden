// #337: the threat model's G4 and the README's `warden-run` row name every account that reads the read-only GitHub
// app's secrets, as `scripts/gcp-setup.sh` grants them. Previews share the live read-only app (#275), so its client
// secret has two readers and its private key four.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const setup = read("scripts/gcp-setup.sh");
const threatModel = read("docs/threat-model.md");
const readme = read("README.md");

/** Each `local <name>_sa="<account>@…"` in the setup script: the variable's name to its account. */
const accounts = new Map(
  [...setup.matchAll(/local (\w+_sa)="(warden-[a-z-]+)@/g)].map((m) => [m[1], m[2]] as const),
);

/** The accounts the setup script grants `secret` to, from its `grant_secrets "$project" "$<account>" …` lines. */
const readersOf = (secret: string) =>
  [...setup.matchAll(/^\s*grant_secrets "\$project" "\$(\w+)" (.*)$/gm)]
    .filter(([, , secrets = ""]) => secrets.split(/\s+/).includes(secret))
    .map(([, account = ""]) => accounts.get(account))
    .sort();

/** The accounts a piece of text names, in backticks. */
const named = (text: string) =>
  [...new Set([...text.matchAll(/`(warden-[a-z-]+)`/g)].map((m) => m[1]))]
    .filter((name) => [...accounts.values()].includes(name))
    .sort();

const row = (doc: string, first: string) =>
  doc.split("\n").find((line) => line.startsWith(`| ${first} |`)) ?? "";

const READ_APP_SECRETS = ["warden-github-app-client-secret", "warden-github-app-private-key"];

describe("the read-only GitHub app's secret readers", () => {
  it.each(READ_APP_SECRETS)("the setup script grants %s to at least one account", (secret) => {
    expect(readersOf(secret)).not.toEqual([]);
  });

  it.each(READ_APP_SECRETS)(
    "G4's clause on %s names exactly the accounts that read it",
    (secret) => {
      const clause = row(threatModel, "G4")
        .split(/[.;] /)
        .find((part) => part.includes(`\`${secret}\``));
      expect(clause, `G4 has no clause naming \`${secret}\``).toBeDefined();
      expect(named(clause ?? "")).toEqual(readersOf(secret));
    },
  );

  it("the README's warden-run row names every account that reads the client secret", () => {
    const wardenRun = row(readme, "`warden-run`");
    for (const reader of readersOf("warden-github-app-client-secret")) {
      expect(wardenRun).toContain(`\`${reader}\``);
    }
  });
});
