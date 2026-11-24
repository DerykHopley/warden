import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReconcileCase, loadReconcileCases } from "../src/reconcile-cases.ts";
import { validCase } from "./fixtures.ts";

/** Collapses whitespace and drops Markdown emphasis, so a quoted sentence matches across the docs' line wraps. */
const plain = (text: string) => text.replaceAll("**", "").replaceAll("`", "").replace(/\s+/g, " ");

describe("the reconcile cases in reconcile-cases/", () => {
  const cases = loadReconcileCases();

  it("are the 21 cases, each a file ReconcileCase accepts, with no two names the same", () => {
    expect(cases).toHaveLength(21);
    expect(new Set(cases.map(({ case: c }) => c.name)).size).toBe(21);
  });

  it("each quote a sentence of GLOSSARY.md or ADR 0005 as the rule they check", () => {
    const sources = plain(
      readFileSync(new URL("../../GLOSSARY.md", import.meta.url), "utf8") +
        readFileSync(
          new URL("../../docs/adr/0005-one-reconcile-step-for-all-findings.md", import.meta.url),
          "utf8",
        ),
    );
    for (const { file, case: c } of cases) {
      expect(sources, `${file} quotes a rule found in neither`).toContain(plain(c.rule));
    }
  });

  it("include case 19, quoting the False positive rule GLOSSARY.md states", () => {
    const glossary = plain(readFileSync(new URL("../../GLOSSARY.md", import.meta.url), "utf8"));
    const case19 = cases.find(({ file }) => file.startsWith("19-"));
    expect(case19?.case.rule).toMatch(
      /False positive that a Scan no longer sees stays a False positive/,
    );
    expect(glossary).toContain(plain(case19!.case.rule));
  });
});

describe("loadReconcileCases()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-cases-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };

  it("returns every case in a folder, parsed, in file-name order", () => {
    write("02-b.json", validCase({ name: "B" }));
    write("01-a.json", validCase({ name: "A" }));
    write("notes.txt", "not a case");
    const loaded = loadReconcileCases(dir);
    expect(loaded.map(({ file, case: c }) => [file, c.name])).toEqual([
      ["01-a.json", "A"],
      ["02-b.json", "B"],
    ]);
  });

  it("fails on a file that isn't valid JSON, naming the file", () => {
    write("01-broken.json", "{ not json");
    expect(() => loadReconcileCases(dir)).toThrow(/01-broken\.json/);
  });

  it("fails on a file ReconcileCase refuses, naming the file and the field", () => {
    write("01-no-rule.json", { ...validCase(), rule: undefined });
    expect(() => loadReconcileCases(dir)).toThrow(/01-no-rule\.json[\s\S]*rule/);
  });

  it("fails on a decision by an agent, naming the file", () => {
    const c = validCase();
    c.steps[1] = {
      ...c.steps[1]!,
      actor: { kind: "agent", id: "judge" },
    } as (typeof c.steps)[number];
    const file = write("07-agent-decides.json", c);
    expect(() => loadReconcileCase(file)).toThrow(/07-agent-decides\.json[\s\S]*actor/);
  });

  it("fails on a reference to an undefined label, naming the file", () => {
    write("08-unknown-label.json", validCase({ expect: [{ id: "f-1" }, { new: "nowhere" }] }));
    expect(() => loadReconcileCases(dir)).toThrow(/08-unknown-label\.json[\s\S]*nowhere/);
  });

  it("fails on two cases with the same name, naming both files", () => {
    write("01-a.json", validCase({ name: "Same" }));
    write("02-b.json", validCase({ name: "Same" }));
    expect(() => loadReconcileCases(dir)).toThrow(/02-b\.json[\s\S]*01-a\.json/);
  });
});
