import { fingerprint, type Finding, type Location } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { patchMoveRule } from "./move-rule.ts";

const shop = { kind: "product", ref: "shop" } as const;

function dependency(pkg: string, vulnerability?: string): Location {
  return {
    kind: "dependency",
    package: pkg,
    version: "4.17.20",
    ...(vulnerability ? { vulnerability } : {}),
  };
}

function finding(id: string, location: Location, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    team: "team-a",
    asset: shop,
    module: "patch",
    rule_id: "patch/known-vulnerability",
    fingerprint: fingerprint("patch/known-vulnerability", location),
    location,
    severity: "high",
    title: "A dependency is vulnerable",
    evidence: { summary: "a known vulnerability" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "refresh-1",
    last_seen_scan: "refresh-1",
    moved_to: null,
    ...overrides,
  };
}

describe("Patch's move rule", () => {
  const fixed = finding("f-lodash", dependency("lodash", "CVE-2021-23337"), { status: "fixed" });

  it("matches the same CVE under another package on the same Asset", () => {
    expect(patchMoveRule(fixed, finding("f-2", dependency("lodash-es", "CVE-2021-23337")))).toBe(
      true,
    );
  });

  it("doesn't match a different CVE", () => {
    expect(patchMoveRule(fixed, finding("f-2", dependency("qs", "CVE-2022-24999")))).toBe(false);
  });

  it("doesn't match the same CVE under the same package, or on another Asset", () => {
    expect(patchMoveRule(fixed, finding("f-2", dependency("lodash", "CVE-2021-23337")))).toBe(
      false,
    );
    const elsewhere = finding("f-2", dependency("lodash-es", "CVE-2021-23337"), {
      asset: { kind: "product", ref: "admin" },
    });
    expect(patchMoveRule(fixed, elsewhere)).toBe(false);
  });

  it("doesn't match when neither names a vulnerability", () => {
    const bare = finding("f-1", dependency("lodash"), { status: "fixed" });
    expect(patchMoveRule(bare, finding("f-2", dependency("lodash-es")))).toBe(false);
  });

  it("doesn't match a Location that isn't a dependency", () => {
    const file = finding("f-2", { kind: "file", path: "package.json" });
    expect(patchMoveRule(fixed, file)).toBe(false);
  });
});
