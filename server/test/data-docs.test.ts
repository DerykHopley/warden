// Story 10: docs/data.md's inventory names the CVE reference data, table by table, and Products, and its "What leaves
// the machine" section says Warden makes no outside call for CVE data.
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

  it("says Warden makes no outside call for CVE data", () => {
    expect(leaves).toMatch(/no outside call for CVE data/);
    for (const source of ["NVD", "CISA KEV", "EPSS", "OSV"]) expect(leaves).toContain(source);
  });
});
