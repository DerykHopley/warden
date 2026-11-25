// @vitest-environment node
// docs/design.md names the tokens; the main stylesheet holds their values, light under :root and dark under the
// prefers-color-scheme media query. Each token in the table is defined in both, and dark adds none.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const design = readFileSync(new URL("../../docs/design.md", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function tableTokens(markdown: string): string[] {
  const section = markdown.split(/^## Tokens$/m)[1]?.split(/^## /m)[0] ?? "";
  const rows = section.split("\n").filter((line) => /^\| `--/.test(line));
  return rows.flatMap((row) =>
    [...(row.split("|")[1] ?? "").matchAll(/`(--[\w-]+)`/g)].map((m) => m[1] ?? ""),
  );
}

function declared(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? "");
}

/** The body of the first `:root { … }` at the top level, and of the one inside the dark media query. */
function blocks(stylesheet: string) {
  const dark = /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/.exec(
    stylesheet,
  )?.[1];
  const light = /^:root\s*{([^}]*)}/m.exec(stylesheet)?.[1];
  return { light: light ?? "", dark: dark ?? "" };
}

describe("design tokens", () => {
  const names = tableTokens(design);
  const { light, dark } = blocks(css);

  it("reads the token names from docs/design.md", () => {
    expect(names).toContain("--bg");
    expect(names).toContain("--sev-low");
    expect(names).toContain("--shadow");
    expect(names).toHaveLength(24);
  });

  it("defines every token in light", () => {
    expect(declared(light).sort()).toEqual([...names].sort());
  });

  it("defines every token in dark, and no new one", () => {
    expect(declared(dark).sort()).toEqual([...names].sort());
  });
});
