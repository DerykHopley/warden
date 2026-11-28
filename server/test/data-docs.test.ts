// Story 10: docs/data.md's inventory names the CVE reference data, table by table, and Products, and its "What leaves
// the machine" section says Warden makes no outside call for CVE data. Vouch's story 12 (spec #341), in part: the
// Team's Catalogues and the Catalogue's text are in the inventory, and Vouch makes no model call.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CVE_TABLES } from "../src/modules/patch/cve-snapshot.ts";

const data = readFileSync(fileURLToPath(new URL("../../docs/data.md", import.meta.url)), "utf8");

/** The inventory row whose Store cell is `store`, or "" when there's none. */
const row = (store: string) =>
  data.split("\n").find((line) => line.startsWith(`| ${store} |`)) ?? "";

/** The "What leaves the machine" section, up to the next heading of its level. */
const leaves = /^## What leaves the machine\n([\s\S]*?)(?=^## )/m.exec(data)?.[1] ?? "";

describe("docs/data.md", () => {
  it.each(CVE_TABLES)("names %s in the CVE reference data row", (table) => {
    expect(row("Cloud SQL: CVE reference data")).toContain(`\`${table}\``);
  });

  it("has a Products row naming what a Product holds", () => {
    const products = row("Cloud SQL: Products");
    for (const held of ["name", "Repo URLs", "dependencies"]) expect(products).toContain(held);
  });

  it("has a write-grants row naming its tables, and the keyring row names the write app's services", () => {
    const grants = row("Cloud SQL: GitHub write grants");
    expect(grants).toContain("`github_write_grants`");
    expect(grants).toContain("`github_write_installations`");
    const keyring = row("The local keyring (development only)");
    for (const service of ["client-id", "client-secret", "private-key"]) {
      expect(keyring).toContain(`\`warden-github-write-app-${service}\``);
    }
  });

  it("names the agent hook's local pseudonym key in the keyring row (#185)", () => {
    expect(row("The local keyring (development only)")).toContain("`warden-pseudonym-key`");
  });

  it("has a Fix PRs row naming its table and what a Fix PR holds", () => {
    const fixPrs = row("Cloud SQL: Fix PRs");
    expect(fixPrs).toContain("`fix_prs`");
    for (const held of ["URL", "number", "branch", "Clerk user id"]) expect(fixPrs).toContain(held);
  });

  it("names the npm and PyPI registries, and that only a package's name is sent", () => {
    const registries = /^- \*\*npm and PyPI:\*\*[\s\S]*?(?=^- )/m.exec(leaves)?.[0] ?? "";
    for (const said of [
      "registry.npmjs.org",
      "pypi.org",
      "package's name",
      "guard/mcp-server-unpinned",
    ]) {
      expect(registries).toContain(said);
    }
    expect(registries).toMatch(/no key, no repo name and no Team/);
  });

  it("marks the write app's branches, commits and Fix PRs, and the Fix PRs row's writing, as built (#313)", () => {
    const gitHub = row("GitHub, through the GitHub app");
    const built = /Built: ([\s\S]*?)(?:Designed:|\|\s*$)/.exec(gitHub)?.[1] ?? "";
    for (const said of ["branch", "commit", "Fix PR", "#313"]) expect(built).toContain(said);
    expect(gitHub).not.toMatch(/Designed: the branches and Fix PRs/);

    const fixPrs = row("Cloud SQL: Fix PRs");
    expect(fixPrs).toMatch(/Built: [^|]*Fix PR route[^|]*#313/);
    expect(fixPrs).not.toMatch(/Designed: writing them/);

    const gitHubLeaves = /^- \*\*GitHub:\*\*[\s\S]*?(?=^- )/m.exec(leaves)?.[0] ?? "";
    for (const said of ["repo-scoped", "default branch", "branch", "commit", "#313"]) {
      expect(gitHubLeaves).toContain(said);
    }
    expect(gitHubLeaves).not.toMatch(/Designed \(#224\)/);
    const registries = /^- \*\*npm and PyPI:\*\*[\s\S]*?(?=^- )/m.exec(leaves)?.[0] ?? "";
    expect(registries).toMatch(/called by the Fix PR route \(built, #313\)/);
  });

  it("has a Vouch Catalogues row naming its table, on or off, and the Admin's Clerk user id (#345)", () => {
    const catalogues = row("Cloud SQL: Vouch Catalogues");
    for (const said of ["`team_catalogues`", "on or off", "Clerk user id", "#345"]) {
      expect(catalogues).toContain(said);
    }
  });

  it("marks the Agent events and Agent session records rows built (#183), the events redacted at their tier (#184)", () => {
    const events = row("Cloud SQL: Agent events");
    const sessions = row("Cloud SQL: Agent session records");
    expect(events).toMatch(
      /Built: [^|]*`agent_events`[^|]*#183[^|]*Privacy tier[^|]*redacted[^|]*#184/,
    );
    expect(sessions).toMatch(/Built: [^|]*`agent_sessions`[^|]*refused[^|]*#183/);
    expect(events).not.toMatch(/\| Designed: Guard spec \|$/);
    expect(sessions).not.toMatch(/\| Designed: Guard spec \|$/);
  });

  it("marks the daily delete and sweep of Agent events built (#499), with no designed wording left for them", () => {
    const events = row("Cloud SQL: Agent events");
    expect(events).toMatch(/daily delete and the daily sweep \(#499\)[^|]*7 days[^|]*50/);
    expect(events).not.toMatch(/not built yet/);
    expect(data).toMatch(/never kept past 7 days \(built, #499/);
    expect(data).not.toMatch(/designed, Guard spec slice 8/);
    expect(data).toMatch(/The daily Job deletes the rest \(built, #499\)/);
  });

  it("marks the OpenRouter row built: the Judge's call (#443), started on each SessionEnd (#444)", () => {
    const openRouter = row("OpenRouter and the model providers behind it");
    expect(openRouter).toMatch(/Built: [^|]*`zdr`[^|]*`data_collection: "deny"`[^|]*#443/);
    expect(openRouter).toMatch(/Built: [^|]*`SessionEnd`[^|]*#444/);
    expect(openRouter).not.toMatch(/\| Designed: Guard spec \|$/);
  });

  it("has a spending ledger row, built (#481), holding no content and naming no person, and says what the limits are", () => {
    const ledger = row("Cloud SQL: spending ledger");
    expect(ledger).toMatch(/Built: [^|]*`spending_ledger`[^|]*#481/);
    for (const field of ["path", "model", "tokens", "cost"]) expect(ledger).toContain(field);
    expect(ledger).toMatch(/no content/);
    expect(leaves).toMatch(/\$1 a day[^\n]*per Team/);
    expect(leaves).toMatch(/2 calls/);
  });

  it("names the Judge's three secrets, read by the Scan Jobs' accounts only, and marks Langfuse built (#482)", () => {
    const secretManager = row("Secret Manager");
    for (const secret of [
      "warden-openrouter-api-key",
      "warden-langfuse-public-key",
      "warden-langfuse-secret-key",
    ]) {
      expect(secretManager).toContain(`\`${secret}\``);
    }
    expect(secretManager).toMatch(
      /Judge's three[^|]*read only by `warden-scan` and `warden-preview-scan`/,
    );
    expect(secretManager).not.toMatch(/Designed: Guard spec \(OpenRouter and Langfuse keys\)/);

    const langfuse = row("Langfuse Cloud");
    expect(langfuse).toMatch(/\| Built: [^|]*#482[^|]*\|$/);
    const langfuseLeaves = /^- \*\*Langfuse:\*\*[\s\S]*?(?=^- )/m.exec(leaves)?.[0] ?? "";
    expect(langfuseLeaves).toMatch(/built, #482/);
    expect(langfuseLeaves).not.toMatch(/designed, Guard spec/);
  });

  it("names one Warden pseudonym key, each Team's key derived from it, in The pseudonym", () => {
    const section = /^## The pseudonym\n([\s\S]*?)(?=^## )/m.exec(data)?.[1] ?? "";
    expect(section).toContain("`WARDEN_PSEUDONYM_KEY`");
    expect(section).toMatch(/each Team's key is derived from it/);
    expect(section).not.toMatch(/a key per Team kept in Secret Manager/);
  });

  it("has a server image row naming the VDA ISA 2027.1 text and its licence", () => {
    const isa = row("Warden's server image: the VDA ISA Catalogue");
    for (const said of ["VDA ISA 2027.1", "CC BY-ND 4.0", "NOTICE.md"]) expect(isa).toContain(said);
  });

  it("says Vouch makes no model call and no outside call", () => {
    expect(leaves).toMatch(
      /^- \*\*Vouch:\*\* none\. Vouch makes no model call and no outside call/m,
    );
  });

  it("says Warden makes no outside call for CVE data", () => {
    expect(leaves).toMatch(/no outside call for CVE data/);
    for (const source of ["NVD", "CISA KEV", "EPSS", "OSV"]) expect(leaves).toContain(source);
  });
});
