import { describe, expect, it } from "vitest";
import { Observation, Scan, SpotRun } from "../src/index.ts";
import {
  agentSession,
  dependencyLocation,
  fileLocation,
  observation,
  product,
  repo,
  scan,
  sessionEvidence,
  sessionObservation,
  spotRun,
} from "./fixtures.ts";
import { expectIssueAt, expectRefused } from "./refused.ts";

describe("Observation", () => {
  it("parses what a Scan saw", () => {
    expect(Observation.parse(observation())).toEqual(observation());
    expect(Observation.parse(sessionObservation())).toEqual(sessionObservation());
  });

  // One assertion per key: a module can't set Status, Fingerprint or history.
  it("refuses a status", () => {
    expectRefused(Observation, observation({ status: "fixed" }), "status");
  });
  it("refuses a fingerprint", () => {
    expectRefused(
      Observation,
      observation({ fingerprint: "guard/agent-can-read-env|file:.claude/settings.json" }),
      "fingerprint",
    );
  });
  it("refuses an id", () => {
    expectRefused(Observation, observation({ id: "f-1" }), "id");
  });
  it("refuses a first_seen_scan", () => {
    expectRefused(Observation, observation({ first_seen_scan: "scan-0" }), "first_seen_scan");
  });

  it("holds the Asset, Location and session-evidence pairing rules", () => {
    expectRefused(Observation, observation({ location: { kind: "session" } }), "location");
    expectRefused(
      Observation,
      sessionObservation({ location: { kind: "file", path: ".env" } }),
      "location",
    );
    expectRefused(
      Observation,
      sessionObservation({ evidence: { summary: "The agent printed .env" } }),
      "session",
    );
    expectRefused(
      Observation,
      observation({ evidence: { summary: "x", session: sessionEvidence() } }),
      "session",
    );
  });
});

describe("Scan", () => {
  it("parses a Scan whose Observations are inside what it covered", () => {
    expect(Scan.parse(scan())).toEqual(scan());
    expect(Scan.safeParse(scan({ observations: [] })).success).toBe(true);
  });

  it("refuses an Observation on an Asset it didn't cover", () => {
    expectRefused(
      Scan,
      scan({
        observations: [
          observation({ asset: { kind: "repo", ref: "https://github.com/example/api" } }),
        ],
      }),
      "asset",
    );
  });

  it("refuses an Observation of a Rule it didn't cover", () => {
    expectRefused(
      Scan,
      scan({ observations: [observation({ rule_id: "guard/mcp-server-unpinned" })] }),
      "rule_id",
    );
  });

  it("refuses a Rule of another module", () => {
    expectRefused(
      Scan,
      scan({ rules: ["guard/agent-can-read-env", "patch/known-vulnerability"] }),
      "rules",
    );
  });

  it("refuses an Agent session Asset: only a Spot run reports on one", () => {
    expectRefused(Scan, scan({ assets: [repo, agentSession], observations: [] }), "assets");
  });

  it("refuses a Scan that covers nothing", () => {
    expectRefused(Scan, scan({ assets: [], observations: [] }), "assets");
    expectRefused(Scan, scan({ rules: [], observations: [] }), "rules");
  });

  it("refuses the same Asset twice in what it covered, on the second one", () => {
    const api = { kind: "repo", ref: "https://github.com/example/api" };
    expectIssueAt(Scan, scan({ assets: [repo, api, { ...repo }] }), ["assets", 2]);
    expect(Scan.safeParse(scan({ assets: [repo, api] })).success).toBe(true);
    // The same ref under another kind is another Asset.
    expect(
      Scan.safeParse(scan({ assets: [repo, { kind: "product", ref: repo.ref }] })).success,
    ).toBe(true);
  });

  it("refuses the same Rule twice in what it covered, on the second one", () => {
    expectIssueAt(Scan, scan({ rules: ["guard/agent-can-read-env", "guard/agent-can-read-env"] }), [
      "rules",
      1,
    ]);
  });

  describe("refuses one problem reported twice: the same Asset and Fingerprint", () => {
    it.each(sameProblemTwice)("$name", ({ first, second }) => {
      const value = scan({ rules: rulesOf(first, second), observations: [first, second] });
      expectIssueAt(Scan, value, ["observations", 1], /observations\[0\]/);
    });

    it("accepts the same Fingerprint on two Assets, and two Fingerprints on one Asset", () => {
      const api = { kind: "repo", ref: "https://github.com/example/api" };
      expect(
        Scan.safeParse(
          scan({
            assets: [repo, api],
            observations: [observation(), observation({ asset: api })],
          }),
        ).success,
      ).toBe(true);
      expect(
        Scan.safeParse(
          scan({
            observations: [
              observation(),
              observation({ location: { kind: "file", path: ".claude/settings.local.json" } }),
            ],
          }),
        ).success,
      ).toBe(true);
    });
  });
});

/** Two Observations of one problem: the same Asset and Fingerprint, differing only where the Fingerprint doesn't look. */
const sameProblemTwice = [
  {
    name: "a different line",
    first: observation(),
    second: observation({ location: { ...fileLocation, line: 9 } }),
  },
  {
    name: "a different severity and evidence",
    first: observation(),
    second: observation({ severity: "low", evidence: { summary: "seen again" } }),
  },
  {
    name: "a different dependency version",
    first: observation({
      asset: repo,
      rule_id: "guard/agent-added-dependency",
      location: { ...dependencyLocation, version: "4.17.20" },
    }),
    second: observation({
      asset: repo,
      rule_id: "guard/agent-added-dependency",
      location: { ...dependencyLocation, version: "4.17.21" },
    }),
  },
];

const rulesOf = (...observations: { rule_id: string }[]) => [
  ...new Set(observations.map((o) => o.rule_id)),
];

describe("SpotRun", () => {
  it("has no assets or rules", () => {
    expectRefused(SpotRun, spotRun({ assets: [agentSession] }), "assets");
    expectRefused(SpotRun, spotRun({ rules: ["guard/agent-read-secret-file"] }), "rules");
  });

  it("accepts an Observation on any Asset, an Agent session included", () => {
    expect(SpotRun.safeParse(spotRun()).success).toBe(true);
    expect(
      SpotRun.safeParse(spotRun({ observations: [observation(), sessionObservation()] })).success,
    ).toBe(true);
    const onProduct = observation({
      asset: product,
      rule_id: "guard/agent-added-dependency",
      location: { kind: "dependency", package: "left-pad", version: "1.3.0" },
    });
    expect(SpotRun.safeParse(spotRun({ observations: [onProduct] })).success).toBe(true);
  });

  it("refuses an Observation of a Rule of another module", () => {
    expectRefused(
      SpotRun,
      spotRun({ observations: [observation({ rule_id: "patch/known-vulnerability" })] }),
      "rule_id",
    );
  });

  describe("refuses one problem reported twice: the same Asset and Fingerprint", () => {
    it.each(sameProblemTwice)("$name", ({ first, second }) => {
      expectIssueAt(
        SpotRun,
        spotRun({ observations: [first, second] }),
        ["observations", 1],
        /observations\[0\]/,
      );
    });

    it("accepts the same Fingerprint on two Assets", () => {
      const onApi = observation({ asset: { kind: "repo", ref: "https://github.com/example/api" } });
      expect(SpotRun.safeParse(spotRun({ observations: [observation(), onApi] })).success).toBe(
        true,
      );
    });
  });
});

describe("Title", () => {
  it.each([" ", "   ", "\t", "\n", " \t\r\n "])(
    "refuses a title of only whitespace (%j) on an Observation",
    (title) => {
      expectRefused(Observation, observation({ title }), "title");
    },
  );

  it("accepts a title with a character among the spaces", () => {
    expect(Observation.safeParse(observation({ title: "  x  " })).success).toBe(true);
  });
});
