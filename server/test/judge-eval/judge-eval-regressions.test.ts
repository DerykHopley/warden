// The Judge eval's regression check (spec #225, story 16; slice 10c): `findRegressions` over two saved results files,
// and `eval:regressions`, which lists each case a rerun broke on each model, with the line that reruns them, from
// hand-made files: no database and no model.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_READS_SECRETS, AGENT_SENDS_SECRETS } from "../../src/modules/guard/judge-rules.ts";
import { runCommand } from "../child-process.ts";
import { findRegressions, rerunLine } from "./regressions.ts";
import { casePasses, type EvalResultLine } from "./results.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** One saved result on a local model: a case labelled with AGENT_SENDS_SECRETS, flagged with `flagged`, its pass
 * worked out, and `change` over it. */
function line(name: string, flagged: string[], change: Partial<EvalResultLine> = {}) {
  const merged: EvalResultLine = {
    model: "qwen3:8b",
    provider: "local",
    case: name,
    group: "misbehaving",
    split: "dev",
    labels: [AGENT_SENDS_SECRETS],
    flagged,
    missing: [],
    extra: [],
    outcome: flagged.length > 0 ? "flagged" : "clean",
    pass: true,
    input_tokens: 1000,
    output_tokens: 100,
    cost_usd: 0,
    calls: 1,
    events_read: 4,
    events_cut: 0,
    ms: 1200,
    error: null,
    at: "2026-11-28T10:00:00.000Z",
    ...change,
  };
  const missing = merged.labels.filter((rule) => !merged.flagged.includes(rule));
  const extra = merged.flagged.filter((rule) => !merged.labels.includes(rule));
  return { ...merged, missing, extra, pass: casePasses({ ...merged, missing, extra }) };
}

const passes = (name: string, change: Partial<EvalResultLine> = {}) =>
  line(name, [AGENT_SENDS_SECRETS], change);
const fails = (name: string, change: Partial<EvalResultLine> = {}) =>
  line(name, [AGENT_READS_SECRETS], change);

const OTHER = { model: "gemma3:12b" } as const;

/** A new results file holding `lines`, one JSON line each, or `text` as it is. */
function resultsFile(content: EvalResultLine[] | string): string {
  const file = join(mkdtempSync(join(tmpdir(), "warden-regressions-")), "results.jsonl");
  const text =
    typeof content === "string"
      ? content
      : content.map((saved) => `${JSON.stringify(saved)}\n`).join("");
  writeFileSync(file, text);
  return file;
}

/** `eval:regressions` run as the script runs it, from server/, on `args`, with only PATH and HOME. */
const evalRegressions = (args: string[]) =>
  runCommand(
    [process.execPath, "test/judge-eval/regressions-cli.ts", "--", ...args],
    {},
    {
      cwd: SERVER_DIR,
      clean: true,
    },
  );

describe("findRegressions: each case that passed in the earlier file and fails in the later", () => {
  it("lists a flip under its model only, with the later line's missing and extra Rules", () => {
    const found = findRegressions(
      [passes("a"), passes("b"), passes("a", OTHER), passes("b", OTHER)],
      [passes("a"), fails("b"), passes("a", OTHER), passes("b", OTHER)],
    );

    expect(found.models).toEqual([
      {
        provider: "local",
        model: "qwen3:8b",
        flips: [
          { case: "b", missing: [AGENT_SENDS_SECRETS], extra: [AGENT_READS_SECRETS], error: null },
        ],
        notInBoth: [],
      },
      { provider: "local", model: "gemma3:12b", flips: [], notInBoth: [] },
    ]);
  });

  it("doesn't list a case that failed before and passes now", () => {
    const found = findRegressions([fails("a")], [passes("a")]);

    expect(found.models[0]!.flips).toEqual([]);
  });

  it("reads only each file's latest line for a (model, case)", () => {
    const found = findRegressions(
      [fails("a"), passes("a"), passes("b")],
      [fails("a"), passes("a"), passes("b"), fails("b")],
    );

    expect(found.models[0]!.flips.map((flip) => flip.case)).toEqual(["b"]);
  });

  it("lists a flip whose later line has an error with that error", () => {
    const error = "the Judge's model call answered 500";
    const found = findRegressions(
      [passes("a")],
      [line("a", [], { outcome: null, error, events_read: null })],
    );

    expect(found.models[0]!.flips).toEqual([
      { case: "a", missing: [AGENT_SENDS_SECRETS], extra: [], error },
    ]);
  });

  it("lists a case on a model in only one file under not in both, not as a flip", () => {
    const found = findRegressions([passes("a"), passes("b")], [fails("a"), fails("c")]);

    expect(found.models[0]).toMatchObject({
      flips: [{ case: "a" }],
      notInBoth: [
        { case: "b", in: "earlier" },
        { case: "c", in: "later" },
      ],
    });
  });

  it("names a model in only one file apart, with no flips", () => {
    const found = findRegressions(
      [passes("a"), passes("a", OTHER)],
      [passes("a"), fails("a", { provider: "openrouter", model: "paid/model" })],
    );

    expect(found.models.map(({ model }) => model)).toEqual(["qwen3:8b"]);
    expect(found.onlyIn).toEqual([
      { provider: "local", model: "gemma3:12b", in: "earlier" },
      { provider: "openrouter", model: "paid/model", in: "later" },
    ]);
  });
});

describe("rerunLine: the line that reruns a model's flips into a new results file", () => {
  it("names a local model in WARDEN_EVAL_LOCAL_MODELS and an OpenRouter one in WARDEN_EVAL_OPENROUTER_MODELS", () => {
    expect(rerunLine({ provider: "local", model: "qwen3:8b" }, ["a", "b"])).toBe(
      "WARDEN_EVAL_RESULTS=rerun-qwen3-8b.jsonl WARDEN_EVAL_LOCAL_MODELS=qwen3:8b " +
        "WARDEN_EVAL_CASES=a,b pnpm --filter @warden/server eval:judge",
    );
    expect(rerunLine({ provider: "openrouter", model: "anthropic/claude-haiku-5.5" }, ["a"])).toBe(
      "WARDEN_EVAL_RESULTS=rerun-anthropic-claude-haiku-5.5.jsonl " +
        "WARDEN_EVAL_OPENROUTER_MODELS=anthropic/claude-haiku-5.5 " +
        "WARDEN_EVAL_CASES=a pnpm --filter @warden/server eval:judge",
    );
  });
});

describe("eval:regressions: the flips between two saved files", () => {
  it("lists the one case that broke on one of two models, with its Rules and rerun line, and exits 1", async () => {
    const earlier = resultsFile([passes("a"), passes("b"), passes("a", OTHER), passes("b", OTHER)]);
    const later = resultsFile([passes("a"), fails("b"), passes("a", OTHER), passes("b", OTHER)]);

    const { code, stdout } = await evalRegressions([earlier, later]);

    expect(code).toBe(1);
    expect(stdout).toBe(
      [
        "local qwen3:8b: 1 case broke",
        `  b: missing ${AGENT_SENDS_SECRETS}; extra ${AGENT_READS_SECRETS}`,
        `  rerun: ${rerunLine({ provider: "local", model: "qwen3:8b" }, ["b"])}`,
        "local gemma3:12b: no case broke",
        "",
      ].join("\n"),
    );
  });

  it("lists no case and exits 0 when none broke, naming what's in only one file", async () => {
    const earlier = resultsFile([fails("a"), passes("b")]);
    const later = resultsFile([passes("a"), passes("c")]);

    const { code, stdout } = await evalRegressions([earlier, later]);

    expect(code).toBe(0);
    expect(stdout).toBe(
      ["local qwen3:8b: no case broke", "  not in both: b (earlier only), c (later only)", ""].join(
        "\n",
      ),
    );
  });

  it("lists a flip with an error by its error, and a model in one file as such", async () => {
    const error = "the Judge's model call answered 500";
    const earlier = resultsFile([passes("a"), passes("a", OTHER)]);
    const later = resultsFile([line("a", [], { outcome: null, error, events_read: null })]);

    const { code, stdout } = await evalRegressions([earlier, later]);

    expect(code).toBe(1);
    expect(stdout).toContain(`  a: ${error}\n`);
    expect(stdout).toContain("local gemma3:12b: only in the earlier file\n");
  });

  it("exits 2 with its usage when not given two paths", async () => {
    const { code, stderr } = await evalRegressions([resultsFile([passes("a")])]);

    expect(code).toBe(2);
    expect(stderr).toContain("usage: pnpm --filter @warden/server eval:regressions -- ");
  });

  it("exits 2 naming a missing file", async () => {
    const missing = join(tmpdir(), "warden-no-such-results.jsonl");

    const { code, stderr } = await evalRegressions([resultsFile([passes("a")]), missing]);

    expect(code).toBe(2);
    expect(stderr).toContain(missing);
  });

  it("exits 2 naming the file and the line that isn't JSON", async () => {
    const bad = resultsFile(`${JSON.stringify(passes("a"))}\nnot json\n`);

    const { code, stderr } = await evalRegressions([resultsFile([passes("a")]), bad]);

    expect(code).toBe(2);
    expect(stderr).toContain(`${bad} line 2`);
  });

  it("exits 2 when no model is in both files", async () => {
    const { code, stderr } = await evalRegressions([
      resultsFile([passes("a")]),
      resultsFile([passes("a", OTHER)]),
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain("no model is in both files");
  });
});
