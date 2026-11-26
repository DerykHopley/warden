// The Verdict function's case table (spec #341, story 2): a Control's Verdict, its reason and each Rule's own Verdict,
// worked out from the Team's held Assets, Scan coverage, Findings and Judge Spot run. Pure: no database, no clock.
import type { AssetKind, RuleId, Status, Verdict } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import type { CoverageEntry } from "../../findings/index.ts";
import {
  rollUp,
  workOutVerdict,
  type RuleEvidence,
  type VerdictFinding,
  type WorkedOutVerdict,
} from "./verdict.ts";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const DAY = 24 * 3600_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const APP = "https://github.com/example/app";
const API = "https://github.com/example/api";
const SHOP = "product-shop";
const LAPTOP = "device-laptop";

const ENV: RuleId = "guard/agent-can-read-env";
const BASH: RuleId = "guard/blanket-bash-allow";
const SECRET: RuleId = "guard/secret-in-repo";
const VULN: RuleId = "patch/known-vulnerability";

const covered = (rule: RuleId, kind: AssetKind, ref: string, days: number): CoverageEntry => ({
  rule_id: rule,
  asset: { kind, ref },
  last_covered_at: daysAgo(days),
});

let made = 0;
const finding = (kind: AssetKind, ref: string, status: Status): VerdictFinding => ({
  id: `f-${++made}`,
  asset: { kind, ref },
  status,
});

/** One Rule's evidence: the Assets held, its coverage and its Findings. */
const rule = (
  rule_id: RuleId,
  held: string[],
  coverage: CoverageEntry[] = [],
  findings: VerdictFinding[] = [],
): RuleEvidence => ({ rule_id, held, coverage, findings });

const byRules = (...rules: RuleEvidence[]): WorkedOutVerdict =>
  workOutVerdict({ kind: "rules", rules, now: NOW });

const judge = (last_run_at: string | null): WorkedOutVerdict =>
  workOutVerdict({ kind: "judge_spot_run", last_run_at, now: NOW });

describe("workOutVerdict: one Rule", () => {
  it("with no coverage, is not evidenced", () => {
    const result = byRules(rule(ENV, [APP]));

    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("No Scan in the last 30 days");
  });

  it("with coverage older than 30 days, is not evidenced, and still shows when it was covered", () => {
    const result = byRules(rule(ENV, [APP], [covered(ENV, "repo", APP, 31)]));

    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("No Scan in the last 30 days");
    expect(result.kind === "rules" && result.rules[0]).toMatchObject({
      verdict: "not_evidenced",
      last_covered_at: daysAgo(31),
      covered: [],
      held: [APP],
    });
  });

  it("with coverage exactly 30 days old, is covered", () => {
    expect(byRules(rule(ENV, [APP], [covered(ENV, "repo", APP, 30)])).verdict).toBe("evidenced");
  });

  // A Control whose only Rule is partly evidenced rolls up to not evidenced: none of its Rules is evidenced.
  it("with coverage on some but not all Repo Assets, is partly evidenced", () => {
    const result = byRules(rule(ENV, [APP, API], [covered(ENV, "repo", APP, 2)]));

    expect(result.kind === "rules" && result.rules[0]).toMatchObject({
      verdict: "partly_evidenced",
      covered: [APP],
      held: [APP, API],
    });
    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("1 of 2 Repos not scanned in the last 30 days");
  });

  it("with full coverage and one Open Finding, is partly evidenced", () => {
    const open = finding("repo", APP, "open");
    const result = byRules(rule(ENV, [APP], [covered(ENV, "repo", APP, 1)], [open]));

    expect(result.kind === "rules" && result.rules[0]).toMatchObject({
      verdict: "partly_evidenced",
      open: [open.id],
    });
    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("1 Open Finding on 1 Repo");
  });

  it("with full coverage and only Accepted, False positive and Fixed Findings (an Unconfirmed fix's too), is evidenced", () => {
    const result = byRules(
      rule(
        ENV,
        [APP, API],
        [covered(ENV, "repo", APP, 1), covered(ENV, "repo", API, 29)],
        [
          finding("repo", APP, "accepted"),
          finding("repo", APP, "false_positive"),
          finding("repo", API, "fixed"),
        ],
      ),
    );

    expect(result.verdict).toBe("evidenced");
    expect(result.reason).toBe("Every Repo scanned in the last 30 days, nothing Open");
    expect(result.kind === "rules" && result.rules[0]).toMatchObject({
      verdict: "evidenced",
      last_covered_at: daysAgo(1),
      covered: [APP, API],
      open: [],
    });
  });

  it("for patch/known-vulnerability, with a Team that holds no Products, is not evidenced", () => {
    const result = byRules(rule(VULN, [], [covered(VULN, "repo", APP, 1)]));

    expect(result.verdict).toBe("not_evidenced");
    expect(result.kind === "rules" && result.rules[0]).toMatchObject({ covered: [], held: [] });
  });

  it("for patch/known-vulnerability, is judged on Products", () => {
    const result = byRules(rule(VULN, [SHOP], [covered(VULN, "product", SHOP, 3)]));

    expect(result.verdict).toBe("evidenced");
    expect(result.reason).toBe("Every Product scanned in the last 30 days, nothing Open");
  });

  it("for a guard/ Rule covered only on a device, is not evidenced", () => {
    const result = byRules(rule(ENV, [APP], [covered(ENV, "device", LAPTOP, 1)]));

    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("No Scan in the last 30 days");
  });

  it("ignores coverage and Open Findings on a Repo the Team no longer holds", () => {
    const result = byRules(
      rule(
        ENV,
        [APP],
        [covered(ENV, "repo", APP, 1), covered(ENV, "repo", API, 1)],
        [finding("repo", API, "open")],
      ),
    );

    expect(result.verdict).toBe("evidenced");
    expect(result.kind === "rules" && result.rules[0]).toMatchObject({ covered: [APP], open: [] });
  });

  it("ignores another Rule's coverage", () => {
    expect(byRules(rule(ENV, [APP], [covered(BASH, "repo", APP, 1)])).verdict).toBe(
      "not_evidenced",
    );
  });

  it("for a Rule of no module Vouch judges by Assets, throws", () => {
    expect(() => byRules(rule("vouch/something", [APP]))).toThrow(/vouch\/something/);
  });
});

describe("workOutVerdict: 5.2.4, judged on the Judge Spot run", () => {
  it("with a Guard Spot run 29 days ago, is evidenced", () => {
    const result = judge(daysAgo(29));

    expect(result).toMatchObject({
      verdict: "evidenced",
      reason: "Judge Spot run on 2026-10-28",
      kind: "judge_spot_run",
      last_run_at: daysAgo(29),
    });
  });

  it("with one 31 days ago, is not evidenced", () => {
    const result = judge(daysAgo(31));

    expect(result.verdict).toBe("not_evidenced");
    expect(result.reason).toBe("No Judge Spot run in the last 30 days");
  });

  it("with none, is not evidenced", () => {
    expect(judge(null)).toMatchObject({
      verdict: "not_evidenced",
      reason: "No Judge Spot run in the last 30 days",
      last_run_at: null,
    });
  });
});

describe("rollUp: a Control's Verdict from its Rules'", () => {
  const cases: [Verdict[], Verdict][] = [
    [["evidenced"], "evidenced"],
    [["evidenced", "evidenced", "evidenced"], "evidenced"],
    [["not_evidenced"], "not_evidenced"],
    [["partly_evidenced"], "not_evidenced"],
    [["partly_evidenced", "not_evidenced"], "not_evidenced"],
    [["partly_evidenced", "partly_evidenced"], "not_evidenced"],
    [["evidenced", "not_evidenced"], "partly_evidenced"],
    [["evidenced", "partly_evidenced"], "partly_evidenced"],
    [["not_evidenced", "evidenced", "partly_evidenced"], "partly_evidenced"],
    [[], "not_evidenced"],
  ];

  it.each(cases)("%j rolls up to %s", (verdicts, expected) => {
    expect(rollUp(verdicts)).toBe(expected);
  });
});

describe("workOutVerdict: the reason", () => {
  it("counts three Open Findings on two covered Repos", () => {
    const result = byRules(
      rule(
        ENV,
        [APP, API],
        [covered(ENV, "repo", APP, 1), covered(ENV, "repo", API, 1)],
        [finding("repo", APP, "open"), finding("repo", APP, "open")],
      ),
      rule(
        SECRET,
        [APP, API],
        [covered(SECRET, "repo", APP, 1), covered(SECRET, "repo", API, 1)],
        [finding("repo", API, "open")],
      ),
    );

    expect(result.reason).toBe("3 Open Findings on 2 Repos");
  });

  it("names Repos and Products together", () => {
    const result = byRules(
      rule(
        ENV,
        [APP, API],
        [covered(ENV, "repo", APP, 1), covered(ENV, "repo", API, 1)],
        [finding("repo", APP, "open"), finding("repo", API, "open")],
      ),
      rule(VULN, [SHOP], [covered(VULN, "product", SHOP, 1)], [finding("product", SHOP, "open")]),
    );

    expect(result.reason).toBe("3 Open Findings on 2 Repos and 1 Product");
  });

  it("joins Open Findings and Assets not scanned with '; '", () => {
    const result = byRules(
      rule(ENV, [APP, API], [covered(ENV, "repo", APP, 1)], [finding("repo", APP, "open")]),
    );

    expect(result.reason).toBe(
      "1 Open Finding on 1 Repo; 1 of 2 Repos not scanned in the last 30 days",
    );
  });

  it("counts a Repo not scanned for one of the Control's Rules once", () => {
    const result = byRules(
      rule(ENV, [APP, API], [covered(ENV, "repo", APP, 1), covered(ENV, "repo", API, 1)]),
      rule(BASH, [APP, API], [covered(BASH, "repo", APP, 1)]),
    );

    expect(result.reason).toBe("1 of 2 Repos not scanned in the last 30 days");
  });

  it("names a kind of Asset the Team holds none of", () => {
    const result = byRules(rule(ENV, [APP], [covered(ENV, "repo", APP, 1)]), rule(VULN, []));

    expect(result.reason).toBe("No Products to scan");
  });

  it("names Repos and Products together when every one is scanned", () => {
    const result = byRules(
      rule(ENV, [APP], [covered(ENV, "repo", APP, 1)]),
      rule(VULN, [SHOP], [covered(VULN, "product", SHOP, 1)]),
    );

    expect(result.reason).toBe("Every Repo and Product scanned in the last 30 days, nothing Open");
  });

  it("is singular for one of one", () => {
    const result = byRules(
      rule(VULN, [SHOP], [covered(VULN, "product", SHOP, 40)]),
      rule(ENV, [APP], [covered(ENV, "repo", APP, 1)]),
    );

    expect(result.reason).toBe("1 of 1 Product not scanned in the last 30 days");
  });
});
