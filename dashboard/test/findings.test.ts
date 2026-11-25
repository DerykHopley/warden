// @vitest-environment node
// The Findings page's counts and orders, below the page: the summary line, the top 5, the table's view and an Asset's
// words.
import type { FindingsView } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { assetLabel, inView, summaryLine, topFive } from "../src/findings.ts";
import { demoFindings, finding, ID, PRODUCT_ID, SHOP_WEB } from "./findings-fixture.ts";

const view = (fields: Partial<FindingsView> = {}): FindingsView => ({
  status: "open",
  severity: "all",
  module: "all",
  ...fields,
});
const ids = (list: { id: string }[]) => list.map((f) => f.id);

describe("summaryLine", () => {
  it("counts the open Findings and the Critical among them", () => {
    expect(summaryLine(demoFindings)).toBe("7 open Findings, 2 Critical");
  });

  it("says one open Finding in the singular, and leaves out Critical when none is", () => {
    expect(summaryLine([finding("f-1", { severity: "medium" })])).toBe("1 open Finding");
    expect(
      summaryLine([finding("f-1", { severity: "critical" }), finding("f-2", { status: "fixed" })]),
    ).toBe("1 open Finding, 1 Critical");
  });

  it("says Nothing open. when every Finding is closed, and when there are none at all, when they appear", () => {
    expect(summaryLine(demoFindings.filter((f) => f.status !== "open"))).toBe("Nothing open.");
    expect(summaryLine([])).toBe("No Findings yet: they appear after the first Scan.");
  });
});

describe("topFive", () => {
  it("takes the five most urgent Open Findings: Critical, High, Medium, Low, then title, then id", () => {
    expect(ids(topFive(demoFindings))).toEqual([
      ID.secret, // Critical, "A live Stripe…"
      ID.lodash, // Critical, "lodash…"
      ID.minimist, // High, "minimist…": titles compare without case
      ID.envLocal, // High, "The agent can read…"
      ID.printed, // High, "The agent printed…"
    ]);
  });

  it("leaves out every Finding that isn't Open", () => {
    const closed = demoFindings.filter((f) => f.status !== "open");
    expect(topFive(closed)).toEqual([]);
    expect(topFive(demoFindings).every((f) => f.status === "open")).toBe(true);
  });

  it("orders titles that differ only in case or accents by id", () => {
    const list = [
      finding("f-3", { title: "Résumé leak", location: { kind: "file", path: "c" } }),
      finding("f-2", { title: "alpha", location: { kind: "file", path: "b" } }),
      finding("f-1", { title: "Alpha", location: { kind: "file", path: "a" } }),
      finding("f-4", { title: "resume leak", location: { kind: "file", path: "d" } }),
    ];
    expect(ids(topFive(list))).toEqual(["f-1", "f-2", "f-3", "f-4"]);
  });
});

describe("inView", () => {
  it("keeps the Findings matching the view's Status, Severity and module, most urgent first", () => {
    expect(ids(inView(demoFindings, view()))).toEqual([
      ID.secret,
      ID.lodash,
      ID.minimist,
      ID.envLocal,
      ID.printed,
      ID.disk,
      ID.cognito,
    ]);
    expect(ids(inView(demoFindings, view({ status: "fixed" })))).toEqual([ID.envSettings, ID.ws]);
    expect(
      ids(inView(demoFindings, view({ status: "all", severity: "high", module: "patch" }))),
    ).toEqual([ID.minimist, ID.ws]);
  });

  it("is empty when nothing matches", () => {
    expect(inView(demoFindings, view({ status: "accepted", severity: "critical" }))).toEqual([]);
  });
});

describe("assetLabel", () => {
  const products = [SHOP_WEB];

  it("names a Product Asset by its Product, and keeps the ref with no such Product, for another kind, or no Products", () => {
    expect(assetLabel({ kind: "product", ref: PRODUCT_ID }, products)).toBe("Shop web");
    expect(assetLabel({ kind: "product", ref: "shop" }, products)).toBe("shop");
    expect(assetLabel({ kind: "repo", ref: PRODUCT_ID }, products)).toBe(PRODUCT_ID);
    expect(assetLabel({ kind: "product", ref: PRODUCT_ID }, null)).toBe(PRODUCT_ID);
  });
});
