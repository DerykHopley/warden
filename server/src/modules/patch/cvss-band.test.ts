import { describe, expect, it } from "vitest";
import { cvssSeverity } from "./cvss-band.ts";

describe("cvssSeverity", () => {
  it.each([
    [10.0, "critical"],
    [9.0, "critical"],
    [8.9, "high"],
    [7.0, "high"],
    [6.9, "medium"],
    [4.0, "medium"],
    [3.9, "low"],
    [0.0, "low"],
  ] as const)("maps a CVSS score of %s to %s, scored", (score, severity) => {
    expect(cvssSeverity(score, null)).toEqual({ severity, scored: true });
  });

  it.each([
    ["no score, NVD HIGH", null, "HIGH", { severity: "high", scored: true }],
    ["no score, NVD CRITICAL", null, "CRITICAL", { severity: "critical", scored: true }],
    ["no score, NVD MEDIUM", null, "MEDIUM", { severity: "medium", scored: true }],
    ["no score, NVD LOW", null, "LOW", { severity: "low", scored: true }],
    ["neither", null, null, { severity: "medium", scored: false }],
    ["no score, NVD NONE", null, "NONE", { severity: "medium", scored: false }],
    ["a score of 11", 11, null, { severity: "medium", scored: false }],
    ["a score of -1", -1, null, { severity: "medium", scored: false }],
    ["a score of NaN", Number.NaN, null, { severity: "medium", scored: false }],
    ["a score beats NVD's severity", 9.8, "LOW", { severity: "critical", scored: true }],
  ] as const)("%s", (_case, score, nvdSeverity, expected) => {
    expect(cvssSeverity(score, nvdSeverity)).toEqual(expected);
  });
});
