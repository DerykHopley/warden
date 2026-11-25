import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Observation, type ProductDependency } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { CVE_SNAPSHOT_FOLDER } from "./cve-snapshot.ts";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";
import { cveObservation, cvePackage, osvPurl, type CveFacts } from "./scan.ts";
import { verdict, type OsvEntry } from "./verdict.ts";

const framework = (id: string) => PATCH_FRAMEWORKS.find((f) => f.id === id)!;

/** One OSV entry: introduced at 0, fixed at `fixed` when given. */
const entry = (pkg: string, fixed: string | null, ecosystem = "PyPI"): OsvEntry => ({
  ecosystem,
  package: pkg,
  ranges: [{ introduced: "0", fixed, last_affected: null }],
  fixed: fixed === null ? [] : [fixed],
});

describe("osvPurl", () => {
  it("gives, for every OSV package in the snapshot, one of its framework's purls", () => {
    const osv = JSON.parse(readFileSync(join(CVE_SNAPSHOT_FOLDER, "osv.json"), "utf8")) as {
      cves: Record<string, { product: string; ecosystem: string; package: string }[]>;
    };
    const pairs = new Set(
      Object.values(osv.cves)
        .flat()
        .map((e) => JSON.stringify([e.product, e.ecosystem, e.package])),
    );
    expect(pairs.size).toBeGreaterThan(0);
    for (const pair of pairs) {
      const [product, ecosystem, name] = JSON.parse(pair) as [string, string, string];
      expect(framework(product).purls, pair).toContain(osvPurl(ecosystem, name));
    }
  });

  it("spells a PyPI name in lower case with - for _", () => {
    expect(osvPurl("PyPI", "Some_Name")).toBe("pkg:pypi/some-name");
  });

  it("keeps an npm name and a Go module path as they are", () => {
    expect(osvPurl("npm", "flowise-components")).toBe("pkg:npm/flowise-components");
    expect(osvPurl("Go", "github.com/ollama/ollama")).toBe("pkg:golang/github.com/ollama/ollama");
  });

  it("throws, naming it, for an ecosystem Patch has no purl rule for", () => {
    expect(() => osvPurl("crates.io", "x")).toThrow(/crates\.io/);
  });
});

describe("cvePackage", () => {
  it("is the purl of the CVE's first OSV entry", () => {
    const entries = [entry("langchain-core", "0.1.0"), entry("langchain", "0.2.0")];
    expect(cvePackage(framework("langchain"), entries)).toBe("pkg:pypi/langchain-core");
  });

  it("is the framework's first purl for a CVE with no OSV entry", () => {
    expect(cvePackage(framework("flowise"), [])).toBe("pkg:npm/flowise");
  });

  it("is pkg:generic/<framework id> for a framework with no purls", () => {
    expect(cvePackage(framework("dify"), [])).toBe("pkg:generic/dify");
    expect(cvePackage(framework("llama.cpp"), [])).toBe("pkg:generic/llama.cpp");
  });

  it("falls back as if there were no OSV entry when the first entry's ecosystem has no purl rule", () => {
    const crate = [entry("langchain-rs", "1.0.0", "crates.io")];
    expect(cvePackage(framework("langchain"), crate)).toBe("pkg:pypi/langchain");
    expect(cvePackage(framework("dify"), crate)).toBe("pkg:generic/dify");
  });
});

describe("cveObservation", () => {
  const library = (version: string | null): ProductDependency => ({
    framework: "langflow",
    version,
    usage: "library",
    internet_facing: true,
  });

  it("builds a scored KEV CVE with a fix: Severity from its band, the score, KEV, the verdict and the fix", () => {
    const cve: CveFacts = {
      id: "CVE-2025-3248",
      cvss: 9.8,
      severity: "CRITICAL",
      description:
        "Langflow versions prior to 1.3.0 are susceptible to code injection in the /api/v1/validate/code endpoint. A remote attacker can run code.",
      in_kev: true,
    };
    const entries = [entry("langflow", "1.3.0")];
    const outcome = verdict("package", entries, "library", "1.2.0");

    const observation = cveObservation(
      "product-1",
      library("1.2.0"),
      cve,
      "pkg:pypi/langflow",
      outcome,
    );

    expect(Observation.parse(observation)).toEqual(observation);
    expect(observation).toEqual({
      asset: { kind: "product", ref: "product-1" },
      rule_id: "patch/known-vulnerability",
      location: {
        kind: "dependency",
        package: "pkg:pypi/langflow",
        version: "1.2.0",
        vulnerability: "CVE-2025-3248",
      },
      severity: "critical",
      title:
        "CVE-2025-3248: Langflow versions prior to 1.3.0 are susceptible to code injection in the /api/v1/validate/code endpoint.",
      evidence: {
        summary:
          "CVSS 9.8, in CISA KEV. Version 1.2.0 is affected: 1.2.0 is before the fixed version 1.3.0 (langflow); 1.3.0 fixes it.",
      },
    });
  });

  it("builds an unscored CVE with no fix: Medium, 'not scored yet', 'no fix listed', no KEV", () => {
    const cve: CveFacts = {
      id: "CVE-2026-0001",
      cvss: null,
      severity: null,
      description: "Dify lets a guest read files",
      in_kev: false,
    };
    const outcome = verdict("none", [], "self_hosted", null);

    const observation = cveObservation(
      "product-2",
      { framework: "dify", version: null, usage: "self_hosted", internet_facing: false },
      cve,
      "pkg:generic/dify",
      outcome,
    );

    expect(Observation.parse(observation)).toEqual(observation);
    expect(observation.severity).toBe("medium");
    expect(observation.location).toEqual({
      kind: "dependency",
      package: "pkg:generic/dify",
      version: "unknown",
      vulnerability: "CVE-2026-0001",
    });
    expect(observation.title).toBe("CVE-2026-0001: Dify lets a guest read files");
    expect(observation.evidence.summary).toBe(
      "CVSS not scored yet. Version unknown may be affected: no version data for this product; no fix listed.",
    );
  });

  it("names NVD's severity word when NVD gives one but no score", () => {
    const cve: CveFacts = {
      id: "CVE-2026-0002",
      cvss: null,
      severity: "HIGH",
      description: "x.",
      in_kev: false,
    };
    const outcome = verdict("package", [entry("langflow", null)], "library", "1.0.0");

    const observation = cveObservation("p", library("1.0.0"), cve, "pkg:pypi/langflow", outcome);

    expect(observation.severity).toBe("high");
    expect(observation.evidence.summary).toMatch(/^No CVSS score, NVD rates it HIGH\. /);
  });

  it("cuts a first sentence longer than the Title's 200 characters with …", () => {
    const sentence = `${"A very long sentence ".repeat(15)}ends here.`;
    const cve: CveFacts = {
      id: "CVE-2026-0003",
      cvss: 5.0,
      severity: "MEDIUM",
      description: `${sentence} A second sentence.`,
      in_kev: false,
    };
    const outcome = verdict("package", [entry("langflow", "2.0.0")], "library", "1.0.0");

    const { title } = cveObservation("p", library("1.0.0"), cve, "pkg:pypi/langflow", outcome);

    expect(title).toHaveLength(200);
    expect(title.startsWith(`CVE-2026-0003: ${sentence.slice(0, 50)}`)).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  it("takes the first sentence only, with its line breaks as spaces", () => {
    const cve: CveFacts = {
      id: "CVE-2026-0004",
      cvss: 3.1,
      severity: "LOW",
      description: "In langflow v.1.0, the\nupload route trusts a path. It is fixed in 2.0.",
      in_kev: false,
    };
    const outcome = verdict("package", [entry("langflow", "2.0.0")], "library", "1.0.0");

    const observation = cveObservation("p", library("1.0.0"), cve, "pkg:pypi/langflow", outcome);

    expect(observation.title).toBe(
      "CVE-2026-0004: In langflow v.1.0, the upload route trusts a path.",
    );
    expect(observation.severity).toBe("low");
  });

  it("doesn't end the first sentence at e.g. or i.e., or at a full stop before a lower-case word", () => {
    const facts: CveFacts = {
      id: "CVE-2026-0005",
      cvss: 3.1,
      severity: "LOW",
      description: "",
      in_kev: false,
    };
    const outcome = verdict("package", [entry("langflow", "2.0.0")], "library", "1.0.0");
    const titleOf = (description: string) =>
      cveObservation("p", library("1.0.0"), { ...facts, description }, "pkg:pypi/langflow", outcome)
        .title;

    expect(titleOf("A flow, e.g. Basic Prompting, runs code. More here.")).toBe(
      "CVE-2026-0005: A flow, e.g. Basic Prompting, runs code.",
    );
    expect(titleOf("The model, i.e. GPT-4, leaks keys. More here.")).toBe(
      "CVE-2026-0005: The model, i.e. GPT-4, leaks keys.",
    );
    expect(titleOf("Version 1. x of the tool leaks keys. More here.")).toBe(
      "CVE-2026-0005: Version 1. x of the tool leaks keys.",
    );
  });

  it("never cuts a Title through a character made of two UTF-16 units", () => {
    // "CVE-2026-0006: " is 15 units, so unit 198, the last a 200-character cut keeps before its …, is the first
    // half of the first emoji.
    const description = `${"a".repeat(183)}${"😀".repeat(10)}.`;
    const outcome = verdict("package", [entry("langflow", "2.0.0")], "library", "1.0.0");
    const facts: CveFacts = {
      id: "CVE-2026-0006",
      cvss: 3.1,
      severity: "LOW",
      description,
      in_kev: false,
    };

    const { title } = cveObservation("p", library("1.0.0"), facts, "pkg:pypi/langflow", outcome);

    expect(title.isWellFormed()).toBe(true);
    expect(title).toBe(`CVE-2026-0006: ${"a".repeat(183)}…`);
  });
});
