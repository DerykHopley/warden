// Port of Patch's backend/tests/test_verdict.py, through the spike (architecture/spikes/stack-ts/patch-p3 in the
// capstone archive): the same 55 cases, names and expected values. Check ids: A15.n, A16b.2, B67.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  noFix,
  type OsvEntry,
  parseVersion,
  type Usage,
  verdict,
  type Verdict,
  type VerdictKind,
} from "./verdict.ts";

type R = [string | null, string | null, string | null];

/** One OSV entry: ranges as (introduced, fixed, last_affected). */
function entry(ecosystem: string, pkg: string, ...ranges: R[]): OsvEntry {
  const rs = ranges.map(([i, f, la]) => ({ introduced: i, fixed: f, last_affected: la }));
  return {
    ecosystem,
    package: pkg,
    ranges: rs,
    fixed: rs.filter((r) => r.fixed).map((r) => r.fixed!),
  };
}

const LANGFLOW = [entry("PyPI", "langflow", ["0", "1.3.0", null])]; // CVE-2025-3248
const GRADIO = [entry("PyPI", "gradio", ["0", "1.9.0", null])];
const FLOWISE = [
  entry("npm", "flowise", ["0", "3.1.0", null]),
  entry("npm", "flowise-components", ["0", "3.1.0", null]),
];
const FLOWISE_PATCH = [entry("npm", "flowise", ["0", "2.2.7", null])];
const OLLAMA = [entry("Go", "github.com/ollama/ollama", ["0", "0.1.29", null])]; // CVE-2024-28224
const OLLAMA_LAST = [entry("Go", "github.com/ollama/ollama", ["0", null, "0.3.14"])]; // CVE-2024-12055
const CORE_TWO_LINES = [
  entry("PyPI", "langchain-core", ["1.0.0", "1.0.7", null], ["0", "0.3.80", null]),
]; // CVE-2025-65106
const COMMUNITY_LATER = [entry("PyPI", "langchain-community", ["0.2.0", "0.2.19", null])]; // CVE-2024-8309
const NO_FIX_YET = [entry("PyPI", "vllm", ["0.5.0", null, null])];
const BAD_OSV_FIX = [entry("PyPI", "langflow", ["0", "1.3.x", null])];
const BAD_OSV_START = [entry("PyPI", "langflow", ["abc123", "1.3.0", null])];

type Row = [
  case_: string,
  coverage: string,
  entries: OsvEntry[],
  version: string | null,
  want: VerdictKind,
  reason: string,
  fixed: string | null,
];

const TABLE: Row[] = [
  // PEP 440 (PyPI)
  [
    "before the fix",
    "package",
    LANGFLOW,
    "1.2.0",
    "affected",
    "1.2.0 is before the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "exactly the fixed version",
    "package",
    LANGFLOW,
    "1.3.0",
    "not_affected",
    "1.3.0 is at or after the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "after the fix",
    "package",
    LANGFLOW,
    "1.4.2",
    "not_affected",
    "1.4.2 is at or after the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "release candidate of the fix",
    "package",
    LANGFLOW,
    "1.3.0rc1",
    "affected",
    "1.3.0rc1 is before the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "dev release of the fix",
    "package",
    LANGFLOW,
    "1.3.0.dev2",
    "affected",
    "1.3.0.dev2 is before the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "post release of the fix",
    "package",
    LANGFLOW,
    "1.3.0.post1",
    "not_affected",
    "1.3.0.post1 is at or after the fixed version 1.3.0 (langflow)",
    "1.3.0",
  ],
  [
    "PEP 440 compares numbers, not text",
    "package",
    GRADIO,
    "1.10.0",
    "not_affected",
    "1.10.0 is at or after the fixed version 1.9.0 (gradio)",
    "1.9.0",
  ],
  [
    "two fixed lines: old line, before",
    "package",
    CORE_TWO_LINES,
    "0.3.79",
    "affected",
    "0.3.79 is before the fixed version 0.3.80 (langchain-core)",
    "0.3.80",
  ],
  [
    "two fixed lines: old line, fixed",
    "package",
    CORE_TWO_LINES,
    "0.3.80",
    "not_affected",
    "0.3.80 is at or after the fixed version 0.3.80 (langchain-core)",
    "0.3.80",
  ],
  [
    "two fixed lines: new line, before",
    "package",
    CORE_TWO_LINES,
    "1.0.6",
    "affected",
    "1.0.6 is before the fixed version 1.0.7 (langchain-core)",
    "1.0.7",
  ],
  [
    "two fixed lines: new line, fixed",
    "package",
    CORE_TWO_LINES,
    "1.0.7",
    "not_affected",
    "1.0.7 is at or after the fixed version 1.0.7 (langchain-core)",
    "1.0.7",
  ],
  [
    "two fixed lines: pre-release before the new line",
    "package",
    CORE_TWO_LINES,
    "1.0.0a1",
    "not_affected",
    "1.0.0a1 is at or after the fixed version 0.3.80 (langchain-core)",
    "0.3.80",
  ],
  [
    "before the first affected version",
    "package",
    COMMUNITY_LATER,
    "0.1.20",
    "not_affected",
    "0.1.20 is outside the affected versions (langchain-community)",
    null,
  ],
  [
    "affected range with no fix yet",
    "package",
    NO_FIX_YET,
    "0.6.1",
    "affected",
    "0.6.1 is in an affected range with no fix yet (vllm)",
    null,
  ],
  // SemVer (npm)
  [
    "npm: before the fix, in both packages",
    "package",
    FLOWISE,
    "3.0.13",
    "affected",
    "3.0.13 is before the fixed version 3.1.0 (flowise)",
    "3.1.0",
  ],
  [
    "npm: pre-release of the fix",
    "package",
    FLOWISE,
    "3.1.0-beta.1",
    "affected",
    "3.1.0-beta.1 is before the fixed version 3.1.0 (flowise)",
    "3.1.0",
  ],
  [
    "npm: exactly the fixed version",
    "package",
    FLOWISE,
    "3.1.0",
    "not_affected",
    "3.1.0 is at or after the fixed version 3.1.0 (flowise)",
    "3.1.0",
  ],
  [
    "npm: semver compares numbers, not text",
    "package",
    FLOWISE,
    "3.10.0",
    "not_affected",
    "3.10.0 is at or after the fixed version 3.1.0 (flowise)",
    "3.1.0",
  ],
  [
    "npm: a pre-release tag sorts before its release",
    "package",
    FLOWISE_PATCH,
    "2.2.7-patch.1",
    "affected",
    "2.2.7-patch.1 is before the fixed version 2.2.7 (flowise)",
    "2.2.7",
  ],
  // Go module versions
  [
    "Go: with the v prefix, before the fix",
    "package",
    OLLAMA,
    "v0.1.28",
    "affected",
    "v0.1.28 is before the fixed version 0.1.29 (github.com/ollama/ollama)",
    "0.1.29",
  ],
  [
    "Go: with the v prefix, exactly the fix",
    "package",
    OLLAMA,
    "v0.1.29",
    "not_affected",
    "v0.1.29 is at or after the fixed version 0.1.29 (github.com/ollama/ollama)",
    "0.1.29",
  ],
  [
    "Go: release candidate of the fix",
    "package",
    OLLAMA,
    "0.1.29-rc0",
    "affected",
    "0.1.29-rc0 is before the fixed version 0.1.29 (github.com/ollama/ollama)",
    "0.1.29",
  ],
  [
    "Go: last affected version, at it",
    "package",
    OLLAMA_LAST,
    "0.3.14",
    "affected",
    "0.3.14 is at or before the last affected version 0.3.14 (github.com/ollama/ollama); " +
      "no fixed version listed",
    null,
  ],
  [
    "Go: last affected version, after it",
    "package",
    OLLAMA_LAST,
    "0.3.15",
    "not_affected",
    "0.3.15 is outside the affected versions (github.com/ollama/ollama)",
    null,
  ],
  // unknown, with the reason
  ["missing version", "package", LANGFLOW, null, "unknown", "no version given", "1.3.0"],
  ["blank version", "package", CORE_TWO_LINES, "  ", "unknown", "no version given", "1.0.7"],
  [
    "Dify: no package data",
    "none",
    [],
    "1.4.0",
    "unknown",
    "no version data for this product",
    null,
  ],
  ["llama.cpp: commit ranges only", "commits", [], "b4500", "unknown", "only code commits", null],
  [
    "covered product, CVE not in OSV",
    "package",
    [],
    "1.2.0",
    "unknown",
    "no version data for this CVE",
    null,
  ],
  [
    "a version we can't read",
    "package",
    LANGFLOW,
    "latest",
    "unknown",
    "version not understood: 'latest' isn't a PyPI (PEP 440) version",
    "1.3.0",
  ],
  [
    "an OSV fixed version we can't read",
    "package",
    BAD_OSV_FIX,
    "1.2.0",
    "unknown",
    "OSV version not understood: '1.3.x' isn't a PyPI (PEP 440) version",
    null,
  ],
  [
    "an OSV fixed version we can't read, no version given",
    "package",
    BAD_OSV_FIX,
    null,
    "unknown",
    "no version given",
    null,
  ],
  [
    "an OSV introduced version we can't read",
    "package",
    BAD_OSV_START,
    "1.2.0",
    "unknown",
    "OSV version not understood: 'abc123' isn't a PyPI (PEP 440) version",
    "1.3.0",
  ],
];

describe("test_a15_2_verdict_table", () => {
  it.each(TABLE)("%s", (_case, coverage, entries, version, want, reason, fixed) => {
    const v = verdict(coverage, entries, "self_hosted", version);
    expect([v.verdict, v.reason, v.fixed_version]).toEqual([want, reason, fixed]);
  });
});

describe("test_a15_3_who_acts_from_usage", () => {
  it.each([
    ["self_hosted", "you"],
    ["library", "you"],
    ["transitive", "upstream"],
    ["hosted", "vendor"],
  ] as const)("%s -> %s", (usage, who) => {
    const cases: [string, OsvEntry[], string | null][] = [
      ["package", LANGFLOW, "1.2.0"],
      ["none", [], null],
    ];
    for (const [coverage, entries, version] of cases) {
      expect(verdict(coverage, entries, usage, version).who_acts).toBe(who);
    }
  });
});

it("test_a15_2_every_snapshot_version_parses_in_its_ecosystem", () => {
  // The Python test reads the snapshot through the `knowledge` fixture; here, a copy of Patch's fixtures/osv.json.
  const osv = JSON.parse(readFileSync(new URL("./fixtures/osv.json", import.meta.url), "utf8")) as {
    cves: Record<string, OsvEntry[]>;
  };
  let n = 0;
  for (const entries of Object.values(osv.cves)) {
    for (const e of entries) {
      for (const r of e.ranges) {
        for (const v of [r.introduced, r.fixed, r.last_affected]) {
          if (v && v !== "0") {
            parseVersion(e.ecosystem, v);
            n++;
          }
        }
      }
    }
  }
  expect(n).toBeGreaterThan(0); // a renamed fixture key would otherwise pass with nothing checked
});

// --- A16b.2: "no fix yet" ---------------------------------------------------------------------------------------

function _e(...ranges: R[]): OsvEntry {
  return {
    ecosystem: "PyPI",
    package: "p",
    fixed: ranges.filter(([, f]) => f).map(([, f]) => f!),
    ranges: ranges.map(([i, f, la]) => ({ introduced: i, fixed: f, last_affected: la })),
  };
}

describe("test_a16b_2_no_fix_table", () => {
  it.each([
    ["package", [_e(["0", null, null])], true], // an open range
    ["package", [_e(["0", null, "1.2"])], true], // last affected only
    ["package", [_e(["0", "1.3", null])], false], // a fix exists
    ["package", [_e(["0", null, null]), _e(["0", "2.0", null])], false], // one package has a fix
    ["package", [], false], // no OSV record for this CVE
    ["commits", [_e(["0", null, null])], false], // commit ranges only
    ["none", [], false],
  ] as [string, OsvEntry[], boolean][])("%s %j -> %s", (coverage, entries, want) => {
    expect(noFix(coverage, entries)).toBe(want);
  });
});

// --- B67 (#109): a fix under more than one package --------------------------------------------------------------
const MOVED = [
  entry("PyPI", "langchain", ["0", "0.2.0", null]),
  entry("PyPI", "langchain-community", ["0.2.0", "0.2.19", null]),
];
const BOTH_FIXES: [string, string | null][] = [
  ["langchain", "0.2.0"],
  ["langchain-community", "0.2.19"],
];

const fixes = (v: Verdict): [string, string | null][] =>
  v.fixes.map((f) => [f.package, f.fixed_version]);

it("test_b67_1_affected_names_each_packages_fix", () => {
  const v = verdict("package", MOVED, "library", "0.1.5");
  expect([v.verdict, v.fixed_version]).toEqual(["affected", "0.2.0"]);
  expect(v.reason).toBe(
    "0.1.5 is before the fixed version 0.2.0 (langchain); " +
      "OSV also lists langchain-community from 0.2.0, fixed in 0.2.19",
  );
  expect(fixes(v)).toEqual(BOTH_FIXES);
});

const CORE_ONLY_FIX = [
  entry("PyPI", "llama-index", ["0", null, "0.12.5"]),
  entry("PyPI", "llama-index-core", ["0", "0.12.6", null]),
];

type B67Row = [
  string,
  OsvEntry[],
  string | null,
  VerdictKind,
  string,
  string | null,
  [string, string | null][],
];
const B67_TABLE: B67Row[] = [
  [
    "no version: each package's fix",
    MOVED,
    null,
    "unknown",
    "no version given",
    "0.2.19",
    BOTH_FIXES,
  ],
  [
    "in the later package's range",
    MOVED,
    "0.2.5",
    "affected",
    "0.2.5 is before the fixed version 0.2.19 (langchain-community); OSV also lists langchain, fixed in 0.2.0",
    "0.2.19",
    BOTH_FIXES,
  ],
  [
    "past both fixes",
    MOVED,
    "0.2.19",
    "not_affected",
    "0.2.19 is at or after the fixed version 0.2.19 (langchain-community)",
    "0.2.19",
    BOTH_FIXES,
  ],
  [
    "one package: reads as before, no list",
    LANGFLOW,
    "1.2.0",
    "affected",
    "1.2.0 is before the fixed version 1.3.0 (langflow)",
    "1.3.0",
    [],
  ],
  ["one package, no version: no list", LANGFLOW, null, "unknown", "no version given", "1.3.0", []],
  [
    "one package, two ranges: no list",
    CORE_TWO_LINES,
    "1.0.6",
    "affected",
    "1.0.6 is before the fixed version 1.0.7 (langchain-core)",
    "1.0.7",
    [],
  ],
  [
    "two packages, the same fix: the reason reads as before",
    FLOWISE,
    "3.0.13",
    "affected",
    "3.0.13 is before the fixed version 3.1.0 (flowise)",
    "3.1.0",
    [
      ["flowise", "3.1.0"],
      ["flowise-components", "3.1.0"],
    ],
  ],
  [
    "a package with no fix listed",
    CORE_ONLY_FIX,
    "0.12.5",
    "affected",
    "0.12.5 is at or before the last affected version 0.12.5 (llama-index); no fixed version listed; " +
      "OSV also lists llama-index-core, fixed in 0.12.6",
    null,
    [
      ["llama-index", null],
      ["llama-index-core", "0.12.6"],
    ],
  ],
];

describe("test_b67_2_fixes_per_package_table", () => {
  it.each(B67_TABLE)("%s", (_case, entries, version, want, reason, fixed, wantFixes) => {
    const v = verdict("package", entries, "library" as Usage, version);
    expect([v.verdict, v.reason, v.fixed_version, fixes(v)]).toEqual([
      want,
      reason,
      fixed,
      wantFixes,
    ]);
  });
});

it("test_b67_2_the_list_is_the_same_whatever_your_version", () => {
  for (const version of [null, "0.1.5", "0.2.5", "0.3.0", "latest"]) {
    expect(fixes(verdict("package", MOVED, "library", version))).toEqual(BOTH_FIXES);
  }
});
