// The Findings page's view state in the URL: parsed from a query with a default for each field, and written back with
// only the fields that differ from their defaults, in a fixed order.
import { describe, expect, it } from "vitest";
import { FindingsBody, FindingsView, findingsViewPath } from "../src/index.ts";
import { finding } from "./fixtures.ts";

const parse = (query: string) => FindingsView.parse(Object.fromEntries(new URLSearchParams(query)));

describe("FindingsView", () => {
  it("parses an empty query to its defaults: Open, any severity, any module, nothing focused", () => {
    expect(parse("")).toEqual({ status: "open", severity: "all", module: "all" });
  });

  it("reads each field's lower-case enum value", () => {
    expect(parse("status=false_positive&severity=high&module=patch&finding=f-1")).toEqual({
      status: "false_positive",
      severity: "high",
      module: "patch",
      finding: "f-1",
    });
    expect(parse("status=all").status).toBe("all");
  });

  it("falls back to a field's default for a value it doesn't know, and keeps the other fields", () => {
    expect(parse("status=nope&severity=high")).toEqual({
      status: "open",
      severity: "high",
      module: "all",
    });
    expect(parse("status=fixed&severity=HIGH&module=vouchy")).toEqual({
      status: "fixed",
      severity: "all",
      module: "all",
    });
    expect(parse("finding=")).toEqual({ status: "open", severity: "all", module: "all" });
  });

  it("ignores fields it doesn't name", () => {
    expect(parse("page=2&status=accepted")).toEqual({
      status: "accepted",
      severity: "all",
      module: "all",
    });
  });
});

describe("findingsViewPath", () => {
  it("writes the defaults as the bare page path", () => {
    expect(findingsViewPath({ status: "open", severity: "all", module: "all" })).toBe("/findings");
  });

  it("writes only the fields that differ from their defaults, in the order status, severity, module, finding", () => {
    expect(
      findingsViewPath({ finding: "f-9", module: "patch", severity: "high", status: "fixed" }),
    ).toBe("/findings?status=fixed&severity=high&module=patch&finding=f-9");
    expect(findingsViewPath({ status: "open", severity: "low", module: "all" })).toBe(
      "/findings?severity=low",
    );
    expect(findingsViewPath({ status: "all", severity: "all", module: "guard" })).toBe(
      "/findings?status=all&module=guard",
    );
  });

  it("escapes a Finding id for the query", () => {
    expect(
      findingsViewPath({ status: "open", severity: "all", module: "all", finding: "a&b" }),
    ).toBe("/findings?finding=a%26b");
  });

  it("writes a path that parses back to the same view", () => {
    const views: FindingsView[] = [
      { status: "open", severity: "all", module: "all" },
      { status: "false_positive", severity: "critical", module: "vouch", finding: "f-1" },
      { status: "all", severity: "medium", module: "all", finding: "a&b=c" },
    ];
    for (const view of views) {
      const query = findingsViewPath(view).split("?")[1] ?? "";
      expect(parse(query)).toEqual(view);
    }
  });
});

describe("FindingsBody", () => {
  it("holds a list of Finding v1", () => {
    expect(FindingsBody.parse({ findings: [finding()] }).findings).toHaveLength(1);
    expect(FindingsBody.safeParse({ findings: [{ ...finding(), status: "gone" }] }).success).toBe(
      false,
    );
    expect(FindingsBody.safeParse({}).success).toBe(false);
  });
});
