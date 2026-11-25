// The assessment's own logic, below the API: how it reads the Severity band, the OSV links, a dependency that's gone,
// an Accepted Finding's review date and a framework Patch no longer knows. The API test covers the rest.
import { PatchAssessment, type ProductDependency } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { assess, type CveRecord } from "./assessment.ts";

const TODAY = "2026-10-13";

const finding = (given: { status?: "open" | "accepted"; accepted_until?: string | null } = {}) => ({
  id: "finding-1",
  team: "org_a",
  asset: { kind: "product" as const, ref: "product-1" },
  module: "patch" as const,
  rule_id: "patch/known-vulnerability",
  fingerprint: "patch/known-vulnerability|pkg:pypi/langflow|CVE-2025-0001",
  location: {
    kind: "dependency" as const,
    package: "pkg:pypi/langflow",
    version: "1.2.0",
    vulnerability: "CVE-2025-0001",
  },
  severity: "critical" as const,
  title: "CVE-2025-0001: a flaw",
  evidence: { summary: "CVSS 9.8." },
  status: given.status ?? "open",
  unconfirmed_fix: null,
  accepted_reason: given.status === "accepted" ? "Behind the VPN" : null,
  accepted_until: given.accepted_until ?? null,
  first_seen_scan: "scan-1",
  last_seen_scan: "scan-1",
  moved_to: null,
});

const dependency = (internet_facing: boolean): ProductDependency => ({
  framework: "langflow",
  version: "1.2.0",
  usage: "self_hosted",
  internet_facing,
});

const entry = (advisory: string, fixed: string) => ({
  ecosystem: "PyPI",
  package: "langflow",
  advisory,
  ranges: [{ introduced: "0", fixed, last_affected: null }],
  fixed: [fixed],
});

/** A CVE on Langflow, published 2026-01-01, not in KEV, with no EPSS. */
const cve = (given: Partial<CveRecord> = {}): CveRecord => ({
  id: "CVE-2025-0001",
  framework: "langflow",
  published: "2026-01-01",
  severity: "CRITICAL",
  cvss: 9.8,
  url: "https://nvd.nist.gov/vuln/detail/CVE-2025-0001",
  kev: null,
  epss: null,
  osv: [entry("GHSA-aaaa-aaaa-aaaa", "1.3.0")],
  ...given,
});

/** `assess`, its answer parsed with the contract. */
const assessed = (...args: Parameters<typeof assess>) => PatchAssessment.parse(assess(...args));

describe("the priority's Severity", () => {
  it.each([
    ["the score's band over NVD's word", { cvss: 9.8, severity: "HIGH" }, ["critical"]],
    ["NVD's word with no score", { cvss: null, severity: "HIGH" }, ["high severity"]],
    ["none when NVD gave NONE and no score", { cvss: null, severity: "NONE" }, ["not scored yet"]],
  ] as const)("reads %s", (_case, scores, reasons) => {
    const answer = assessed(finding(), dependency(false), cve(scores), TODAY);
    expect(answer.priority.reasons).toEqual(reasons);
  });
});

describe("the OSV links", () => {
  it("gives one per distinct advisory, in OSV's order", () => {
    const osv = [
      entry("GHSA-bbbb-bbbb-bbbb", "1.3.0"),
      entry("GHSA-aaaa-aaaa-aaaa", "1.3.0"),
      entry("GHSA-bbbb-bbbb-bbbb", "1.3.1"),
    ];
    const answer = assessed(finding(), dependency(false), cve({ osv }), TODAY);
    expect(answer.links.osv).toEqual([
      "https://osv.dev/vulnerability/GHSA-bbbb-bbbb-bbbb",
      "https://osv.dev/vulnerability/GHSA-aaaa-aaaa-aaaa",
    ]);
  });

  it("gives none when OSV has none", () => {
    const answer = assessed(finding(), dependency(false), cve({ osv: [] }), TODAY);
    expect([answer.links.osv, answer.verdict]).toEqual([[], "unknown"]);
  });
});

it("counts a dependency that's gone as not internet-facing, with no one to act", () => {
  const facing = assessed(finding(), dependency(true), cve(), TODAY);
  const gone = assessed(finding(), null, cve(), TODAY);

  expect(facing.priority.reasons).toEqual(["critical", "internet-facing"]);
  expect(gone.priority.reasons).toEqual(["critical"]);
  expect([gone.who_acts, gone.verdict, gone.fixed_version]).toEqual([null, "affected", "1.3.0"]);
});

it("reads an Accepted Finding's review date as the UTC day its acceptance ends", () => {
  // 23:30 at -02:00 on the 13th is the 14th in UTC: the review date hasn't come, so it isn't overdue yet.
  const accepted = finding({ status: "accepted", accepted_until: "2026-10-13T23:30:00-02:00" });
  const due = finding({ status: "accepted", accepted_until: "2026-10-13T00:30:00Z" });

  expect(assessed(accepted, dependency(false), cve(), TODAY).priority.overdue).toBe(false);
  expect(assessed(due, dependency(false), cve(), TODAY).priority.overdue).toBe(true);
});

it("reads verdict unknown for a CVE on a framework Patch no longer knows", () => {
  const answer = assessed(finding(), null, cve({ framework: "retired-framework" }), TODAY);
  expect([answer.verdict, answer.reason]).toEqual(["unknown", "no version data for this product"]);
});
