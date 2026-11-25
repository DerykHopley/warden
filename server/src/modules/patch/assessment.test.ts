// The assessment's own logic, below the API: how it reads the Severity band, the OSV links, a dependency that's gone,
// when an Accepted Finding's acceptance ends, a reason too long for the contract and a framework Patch no longer
// knows. The API test covers the rest.
import { PatchAssessment, type ProductDependency } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { assess, type CveRecord } from "./assessment.ts";

const NOW = new Date("2026-10-13T09:30:00Z");

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
    const answer = assessed(finding(), dependency(false), cve(scores), NOW);
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
    const answer = assessed(finding(), dependency(false), cve({ osv }), NOW);
    expect(answer.links.osv).toEqual([
      "https://osv.dev/vulnerability/GHSA-bbbb-bbbb-bbbb",
      "https://osv.dev/vulnerability/GHSA-aaaa-aaaa-aaaa",
    ]);
  });

  it("gives none when OSV has none", () => {
    const answer = assessed(finding(), dependency(false), cve({ osv: [] }), NOW);
    expect(answer.links.osv).toEqual([]);
  });
});

it("counts a dependency that's gone as not internet-facing", () => {
  const facing = assessed(finding(), dependency(true), cve(), NOW);
  const gone = assessed(finding(), null, cve(), NOW);

  expect(facing.priority.reasons).toEqual(["critical", "internet-facing"]);
  expect(gone.priority.reasons).toEqual(["critical"]);
});

it("counts an Accepted Finding overdue only once its acceptance has ended, to the moment", () => {
  // The CVE's due date (published + 30 days) is long past, so only the acceptance keeps it from being overdue. It
  // ends at or before now, as the daily expiry reads it; a later time on the same UTC day hasn't ended it yet.
  const overdue = (accepted_until: string) =>
    assessed(finding({ status: "accepted", accepted_until }), dependency(false), cve(), NOW)
      .priority.overdue;

  expect(overdue("2026-10-13T00:30:00Z")).toBe(true);
  expect(overdue("2026-10-13T09:30:00Z")).toBe(true);
  expect(overdue("2026-10-13T12:00:00Z")).toBe(false);
  expect(overdue("2026-10-13T23:30:00-02:00")).toBe(false);
});

it("cuts a reason longer than the contract's 2000 characters to fit, with … last", () => {
  // Langflow's own fix, then 80 other packages OSV lists with a different fix, each named in the reason.
  const others = Array.from({ length: 80 }, (_, i) => ({
    ...entry(`GHSA-${i}`, "2.0.0"),
    package: `langflow-plugin-${i}`,
  }));
  const osv = [entry("GHSA-aaaa-aaaa-aaaa", "1.3.0"), ...others];

  const { reason } = assessed(finding(), dependency(false), cve({ osv }), NOW);

  expect(reason.length).toBeLessThanOrEqual(2000);
  expect(reason).toMatch(
    /^1\.2\.0 is before the fixed version 1\.3\.0 \(langflow\); OSV also lists langflow-plugin-0, fixed in 2\.0\.0/,
  );
  expect(reason.endsWith("…")).toBe(true);
});

it("reads verdict unknown for a CVE on a framework Patch no longer knows", () => {
  const answer = assessed(finding(), null, cve({ framework: "retired-framework" }), NOW);
  expect([answer.verdict, answer.reason]).toEqual(["unknown", "no version data for this product"]);
});
