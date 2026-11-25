// What the port from Python has to keep that Patch's own tests don't pin: the spike's NOTES.md mismatches
// (padSemver, the trailing "\n", max() tie-breaking), checkVersion's refusal, and where JavaScript's
// defaults differ from Python's (strip, repr, semver's lenient "v") or data Patch never met (other ecosystems).
import { describe, expect, it } from "vitest";
import { VersionRefused } from "./errors.ts";
import {
  checkVersion,
  compareVersions,
  type OsvEntry,
  parseVersion,
  verdict,
  VersionError,
} from "./verdict.ts";

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

const LANGFLOW: OsvEntry[] = [
  {
    ecosystem: "PyPI",
    package: "langflow",
    ranges: [{ introduced: "0", fixed: "1.3.0", last_affected: null }],
    fixed: ["1.3.0"],
  },
];

const summary = (v: ReturnType<typeof verdict>) => [v.verdict, v.reason, v.fixed_version];

describe("an ecosystem Patch has no version rules for", () => {
  it("checkVersion names it in a plain error, not a refusal of the user's version", () => {
    const crate = { packages: [{ ecosystem: "crates.io" }] };
    let thrown: unknown;
    try {
      checkVersion(crate, "Candle", "0.8.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(VersionRefused);
    expect((thrown as Error).message).toBe(
      "OSV ecosystem 'crates.io' has no version rules here: Patch reads PyPI, npm and Go",
    );
  });
});

describe("a CVE whose OSV entries mix PyPI with npm versions", () => {
  const mixed: OsvEntry[] = [
    LANGFLOW[0]!,
    {
      ecosystem: "npm",
      package: "langflow-ui",
      ranges: [{ introduced: "0", fixed: "1.3.0", last_affected: null }],
      fixed: ["1.3.0"],
    },
  ];

  it.each([null, "1.2.0"])("version %s: unknown, not a crash", (version) => {
    expect(summary(verdict("package", mixed, "library", version))).toEqual([
      "unknown",
      "OSV lists this CVE under ecosystems whose versions don't compare: PyPI, npm",
      null,
    ]);
  });
});

describe("an npm or Go version takes one leading v, as Patch does", () => {
  it.each([
    ["npm", "vv1.2.3", "'vv1.2.3' isn't a semver version"],
    ["Go", "vv1.2.3", "'vv1.2.3' isn't a Go module version"],
    ["Go", "Vv1.2.3", "'Vv1.2.3' isn't a Go module version"],
    ["npm", "\u{feff}1.2.3", "'\\ufeff1.2.3' isn't a semver version"],
  ] as const)("%s refuses %j", (ecosystem, text, message) => {
    expect(() => parseVersion(ecosystem, text)).toThrow(new VersionError(message));
  });

  it("v1.2.3 still reads as 1.2.3", () => {
    expect(compareVersions(parseVersion("Go", "v1.2.3"), parseVersion("Go", "1.2.3"))).toBe(0);
  });
});

describe("a version is stripped of Python's whitespace, not JavaScript's", () => {
  it.each([
    ["\x1c\x85", "unknown", "no version given", "1.3.0"],
    ["\x1c1.2.0\x1f", "affected", "1.2.0 is before the fixed version 1.3.0 (langflow)", "1.3.0"],
    [
      "\u{feff}",
      "unknown",
      "version not understood: '\\ufeff' isn't a PyPI (PEP 440) version",
      "1.3.0",
    ],
  ])("%j: %s", (version, want, reason, fixed) => {
    expect(summary(verdict("package", LANGFLOW, "library", version))).toEqual([
      want,
      reason,
      fixed,
    ]);
  });
});

describe("a refused version is quoted as Python's repr() quotes it", () => {
  // Each expected value is Python 3's repr() of the version.
  it.each([
    ["1.0\\beta", "'1.0\\\\beta'"],
    ["it's 1.0\\", `"it's 1.0\\\\"`],
    ["1.0\tbeta", "'1.0\\tbeta'"],
    ["1.0\x00", "'1.0\\x00'"],
    ["1.0\x7f\x85", "'1.0\\x7f\\x85'"],
    ["1.0 \u{2028}x", "'1.0 \\u2028x'"],
    ["1.0\u{e0001} x", "'1.0\\U000e0001 x'"],
    ["1.0\ud800 x", "'1.0\\ud800 x'"],
    ["1.0 \u{e9}", "'1.0 \u{e9}'"],
  ])("%j -> %s", (version, repr) => {
    expect(() => checkVersion({}, "Dify", version)).toThrow(
      `${repr} doesn't look like a version: use letters, digits and . + _ - only.`,
    );
  });
});
