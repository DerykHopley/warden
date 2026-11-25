// What the port from Python has to keep that Patch's own tests don't pin: the spike's NOTES.md mismatches
// (padSemver, the trailing "\n", max() tie-breaking) and checkVersion's refusal.
import { describe, expect, it } from "vitest";
import { VersionRefused } from "./errors.ts";
import { checkVersion, compareVersions, type OsvEntry, parseVersion, verdict } from "./verdict.ts";

function refusal(run: () => void): VersionRefused {
  try {
    run();
  } catch (err) {
    if (err instanceof VersionRefused) return err;
    throw err;
  }
  throw new Error("expected a VersionRefused");
}

describe("a two-part npm or Go version reads as its three-part form (padSemver)", () => {
  it("Ollama's range 0 to 0.1.29 holds v0.1", () => {
    const ollama: OsvEntry[] = [
      {
        ecosystem: "Go",
        package: "github.com/ollama/ollama",
        ranges: [{ introduced: "0", fixed: "0.1.29", last_affected: null }],
        fixed: ["0.1.29"],
      },
    ];
    expect(verdict("package", ollama, "self_hosted", "v0.1").verdict).toBe("affected");
  });

  it("npm's 3.1 compares equal to 3.1.0, and keeps a pre-release", () => {
    expect(compareVersions(parseVersion("npm", "3.1"), parseVersion("npm", "3.1.0"))).toBe(0);
    expect(compareVersions(parseVersion("npm", "3.1-beta"), parseVersion("npm", "3.1.0"))).toBe(-1);
  });
});

describe("checkVersion", () => {
  const noPackageData = {};

  it("accepts a plain version with one trailing newline for a product with no package data", () => {
    expect(() => checkVersion(noPackageData, "Dify", "1.4.0\n")).not.toThrow();
  });

  it("refuses 1.0 beta for a product with no package data", () => {
    const e = refusal(() => checkVersion(noPackageData, "Dify", "1.0 beta"));
    expect([e.code, e.message]).toEqual([
      "bad_version",
      "'1.0 beta' doesn't look like a version: use letters, digits and . + _ - only.",
    ]);
  });

  it("refuses latest for a PyPI product, naming the product and an example", () => {
    const langchain = { packages: [{ ecosystem: "PyPI" }] };
    const e = refusal(() => checkVersion(langchain, "LangChain", "latest"));
    expect([e.code, e.message]).toEqual([
      "bad_version",
      "'latest' isn't a PyPI (PEP 440) version, which LangChain uses. Example: 0.3.27.",
    ]);
  });
});

describe("the newest fix keeps Python's max(): equal versions break the tie by their text", () => {
  const listing = (...fixed: string[]): OsvEntry[] => [
    {
      ecosystem: "PyPI",
      package: "p",
      ranges: fixed.map((f) => ({ introduced: "0", fixed: f, last_affected: null })),
      fixed,
    },
  ];

  it.each([
    ["1.0", "1.0.0"],
    ["1.0.0", "1.0"],
  ])("OSV lists %s then %s: 1.0.0", (first, second) => {
    expect(verdict("package", listing(first, second), "library", null).fixed_version).toBe("1.0.0");
  });
});
