// @vitest-environment node
// docs/design.md, Motion: a filter or view change has no motion, with or without reduced motion. The table swaps at
// once, so nothing on the Findings page's table, rows, cards or filter tabs transitions or animates.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("the Findings page's motion", () => {
  it("gives the table, its rows, the cards and the filter tabs no transition or animation", () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: (selector ?? "").trim(), body: body ?? "" }))
      .filter(({ selector }) => /findings-table|filter-tab|finding-card|top-five/.test(selector));

    expect(rules.length).toBeGreaterThan(0);
    for (const { selector, body } of rules) {
      expect(body, selector).not.toMatch(/transition|animation/);
    }
  });
});
