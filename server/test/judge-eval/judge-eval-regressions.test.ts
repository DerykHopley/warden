// The Judge eval's regression check (spec #225, story 16; slice 10c): `findRegressions` over two saved results files,
// and `eval:regressions`, which lists each case a rerun broke on each model, with the line that reruns them, from
// hand-made files: no database and no model.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_READS_SECRETS, AGENT_SENDS_SECRETS } from "../../src/modules/guard/judge-rules.ts";
import { runCommand } from "../child-process.ts";
import {
  DEFAULT_LOCAL_URL,
  findRegressions,
  regressionsText,
  rerunLine,
  type RerunTarget,
} from "./regressions.ts";
import { resultLine, resultsFile } from "./result-fixtures.ts";
import type { EvalResultLine } from "./results.ts";
import { readEvalSettings } from "./settings.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** When `eval:regressions` ran, in the unit tests: the rerun file's name carries it. */
const AT = new Date("2026-11-28T10:00:00.000Z");

/** Where the unit tests' rerun lines put their file, and the local URL they carry. */
const TARGET: RerunTarget = { folder: "docs/eval/results", localUrl: DEFAULT_LOCAL_URL };

/** `line`'s words as bash reads them, quotes removed and nothing else run. */
async function shellWords(line: string): Promise<string[]> {
  const { code, stdout, stderr } = await runCommand(
    ["bash", "-c", `printf '%s\\n' ${line}`],
    {},
    { cwd: tmpdir(), clean: true },
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return stdout.split("\n").slice(0, -1);
}

/** The variables a rerun line sets before its command, as bash reads them. */
async function lineEnv(line: string): Promise<Record<string, string>> {
  const words = await shellWords(line);
  return Object.fromEntries(
    words
      .slice(0, words.indexOf("pnpm"))
      .map((word) => [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]),
  );
}

/** One saved result on a local model: a case labelled with AGENT_SENDS_SECRETS, flagged with `flagged`. */
const line = (name: string, flagged: string[], change: Partial<EvalResultLine> = {}) =>
  resultLine({
    case: name,
    group: "misbehaving",
    labels: [AGENT_SENDS_SECRETS],
    flagged,
    outcome: flagged.length > 0 ? "flagged" : "clean",
    ...change,
  });

const passes = (name: string, change: Partial<EvalResultLine> = {}) =>
  line(name, [AGENT_SENDS_SECRETS], change);
const fails = (name: string, change: Partial<EvalResultLine> = {}) =>
  line(name, [AGENT_READS_SECRETS], change);

const OTHER = { model: "gemma3:12b" } as const;
const MODEL_ERROR = "the Judge's model call answered 500";
/** A line whose model call failed: nothing flagged, no outcome. */
const errored = (name: string) =>
  line(name, [], { outcome: null, error: MODEL_ERROR, events_read: null });

/** `eval:regressions` run as the script runs it, from server/, on `args`, with only PATH, HOME and `env`. */
const evalRegressions = (args: string[], env: Record<string, string> = {}) =>
  runCommand([process.execPath, "test/judge-eval/regressions-cli.ts", "--", ...args], env, {
    cwd: SERVER_DIR,
    clean: true,
  });

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
    const found = findRegressions([passes("a")], [errored("a")]);

    expect(found.models[0]!.flips).toEqual([
      { case: "a", missing: [AGENT_SENDS_SECRETS], extra: [], error: MODEL_ERROR },
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
  it("names a local model in WARDEN_EVAL_LOCAL_MODELS after its URL, its results file in the folder by provider, model and time", () => {
    expect(rerunLine({ provider: "local", model: "qwen3:8b" }, ["a", "b"], AT, TARGET)).toBe(
      `WARDEN_EVAL_LOCAL_URL=${DEFAULT_LOCAL_URL} ` +
        "WARDEN_EVAL_RESULTS=docs/eval/results/rerun-local-qwen3-8b-20261128T100000.000Z.jsonl " +
        "WARDEN_EVAL_LOCAL_MODELS=qwen3:8b WARDEN_EVAL_CASES=a,b pnpm --filter @warden/server eval:judge",
    );
  });

  it("names a bare file name when the later file is in the folder pnpm runs from", () => {
    expect(
      rerunLine({ provider: "local", model: "qwen3:8b" }, ["a"], AT, { ...TARGET, folder: "" }),
    ).toContain(" WARDEN_EVAL_RESULTS=rerun-local-qwen3-8b-20261128T100000.000Z.jsonl ");
  });

  it("single-quotes a folder the shell would split or expand, so bash reads it as one word", async () => {
    const folder = "/tmp/my results/it's $HOME";
    const line = rerunLine({ provider: "local", model: "qwen3:8b" }, ["a"], AT, {
      ...TARGET,
      folder,
    });

    expect(await shellWords(line)).toContain(
      `WARDEN_EVAL_RESULTS=${folder}/rerun-local-qwen3-8b-20261128T100000.000Z.jsonl`,
    );
  });

  it("single-quotes a local URL the shell would split, so bash reads it as one word", async () => {
    const localUrl = "http://localhost:11434/v1 #1";
    const line = rerunLine({ provider: "local", model: "qwen3:8b" }, ["a"], AT, {
      ...TARGET,
      localUrl,
    });

    expect((await lineEnv(line)).WARDEN_EVAL_LOCAL_URL).toBe(localUrl);
  });

  it("single-quotes a model and cases the shell would split or expand, so bash reads each as one word", async () => {
    const model = "my model;$HOME";
    const cases = ["it's a", "b"];
    const line = rerunLine({ provider: "local", model }, cases, AT, TARGET);

    const env = await lineEnv(line);
    expect(env.WARDEN_EVAL_LOCAL_MODELS).toBe(model);
    expect(env.WARDEN_EVAL_CASES).toBe(cases.join(","));
  });

  it("names an OpenRouter model in WARDEN_EVAL_OPENROUTER_MODELS, its file in the folder, no local URL, marked paid", () => {
    expect(
      rerunLine({ provider: "openrouter", model: "anthropic/claude-haiku-5.5" }, ["a"], AT, TARGET),
    ).toBe(
      "WARDEN_EVAL_RESULTS=docs/eval/results/rerun-openrouter-anthropic-claude-haiku-5.5-20261128T100000.000Z.jsonl " +
        "WARDEN_EVAL_OPENROUTER_MODELS=anthropic/claude-haiku-5.5 " +
        "WARDEN_EVAL_CASES=a pnpm --filter @warden/server eval:judge " +
        "(paid: OpenRouter — needs the owner's yes)",
    );
  });

  it("names a new results file at each run, and one per provider for the same model name", () => {
    const file = (line: string) =>
      line.split(" ").find((word) => word.startsWith("WARDEN_EVAL_RESULTS="));
    const later = new Date(AT.getTime() + 1);
    const local = rerunLine({ provider: "local", model: "m" }, ["a"], AT, TARGET);

    expect(file(local)).toBeDefined();
    expect(file(rerunLine({ provider: "local", model: "m" }, ["a"], later, TARGET))).not.toBe(
      file(local),
    );
    expect(file(rerunLine({ provider: "openrouter", model: "m" }, ["a"], AT, TARGET))).not.toBe(
      file(local),
    );
  });
});

describe("regressionsText: what eval:regressions prints", () => {
  it("prints a model with no flip as no case broke, and the cases in one file under not in both", () => {
    const found = findRegressions([fails("a"), passes("b")], [passes("a"), passes("c")]);

    expect(regressionsText(found, AT, TARGET)).toBe(
      ["local qwen3:8b: no case broke", "  not in both: b (earlier only), c (later only)"].join(
        "\n",
      ),
    );
  });

  it("prints a flip with an error by its error, and a model in one file as such", () => {
    const found = findRegressions([passes("a"), passes("a", OTHER)], [errored("a")]);

    expect(regressionsText(found, AT, TARGET)).toBe(
      [
        "local qwen3:8b: 1 case broke",
        `  a: ${MODEL_ERROR}`,
        `  rerun: ${rerunLine({ provider: "local", model: "qwen3:8b" }, ["a"], AT, TARGET)}`,
        "local gemma3:12b: only in the earlier file",
      ].join("\n"),
    );
  });
});

/** `text` with the time in each rerun file's name made `<at>`: the CLI names it from when it ran. */
const anyTime = (text: string) => text.replace(/-\d{8}T\d{6}\.\d{3}Z\.jsonl/g, "-<at>.jsonl");

describe("eval:regressions: the flips between two saved files", () => {
  it("lists the one case that broke on one of two models, with its Rules and rerun line, and exits 1", async () => {
    const earlier = resultsFile([passes("a"), passes("b"), passes("a", OTHER), passes("b", OTHER)]);
    const later = resultsFile([passes("a"), fails("b"), passes("a", OTHER), passes("b", OTHER)]);

    const { code, stdout } = await evalRegressions([earlier, later]);

    expect(code).toBe(1);
    expect(anyTime(stdout)).toBe(
      [
        "local qwen3:8b: 1 case broke",
        `  b: missing ${AGENT_SENDS_SECRETS}; extra ${AGENT_READS_SECRETS}`,
        `  rerun: WARDEN_EVAL_LOCAL_URL=${DEFAULT_LOCAL_URL} ` +
          `WARDEN_EVAL_RESULTS=${dirname(later)}/rerun-local-qwen3-8b-<at>.jsonl ` +
          "WARDEN_EVAL_LOCAL_MODELS=qwen3:8b WARDEN_EVAL_CASES=b pnpm --filter @warden/server eval:judge",
        "local gemma3:12b: no case broke",
        "",
      ].join("\n"),
    );
  });

  it("exits 0 when no case broke, naming what's in only one file", async () => {
    const earlier = resultsFile([fails("a"), passes("b")]);
    const later = resultsFile([passes("a"), passes("c")]);

    const { code, stdout } = await evalRegressions([earlier, later]);

    expect(code).toBe(0);
    expect(stdout).toContain("not in both");
  });

  it("exits 1 when the only flip has an error", async () => {
    const { code } = await evalRegressions([
      resultsFile([passes("a")]),
      resultsFile([errored("a")]),
    ]);

    expect(code).toBe(1);
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

/** A new folder pnpm is run from (INIT_CWD), with a `results/` folder in it holding `earlier.jsonl`, where case `b`
 * passed on the local model, and `later.jsonl`, where it fails. */
function pnpmRoot(): { root: string; results: string } {
  const root = mkdtempSync(join(tmpdir(), "warden-root-"));
  const results = join(root, "results");
  mkdirSync(results);
  resultsFile([passes("b")], join(results, "earlier.jsonl"));
  resultsFile([fails("b")], join(results, "later.jsonl"));
  return { root, results };
}

/** The one `rerun:` line `eval:regressions` prints, run on `args` with `env`, after it exits 1. */
async function printedRerun(args: [string, string], env: Record<string, string>) {
  const { code, stdout } = await evalRegressions(args, env);
  expect(code).toBe(1);
  const rerun = stdout.split("\n").find((printed) => printed.startsWith("  rerun: "));
  expect(rerun).toBeDefined();
  return rerun!.slice("  rerun: ".length);
}

const IN_RESULTS: [string, string] = ["results/earlier.jsonl", "results/later.jsonl"];

describe("eval:regressions: the rerun line runs as printed", () => {
  it("names the results file in the later file's folder, from where pnpm runs, and passes readEvalSettings", async () => {
    const { root, results } = pnpmRoot();

    const line = await printedRerun(IN_RESULTS, { INIT_CWD: root });

    const env = await lineEnv(line);
    expect(env.WARDEN_EVAL_RESULTS).toMatch(/^results\/rerun-local-qwen3-8b-[^/]+\.jsonl$/);
    const settings = readEvalSettings({ ...env, INIT_CWD: root }, ["a", "b"]);
    expect(dirname(settings.resultsFile)).toBe(results);
    expect(settings.caseNames).toEqual(["b"]);
    expect(settings.models).toEqual([
      { provider: "local", model: "qwen3:8b", url: DEFAULT_LOCAL_URL },
    ]);
  });

  it("names the folder's absolute path when the later file is given absolute, outside where pnpm runs", async () => {
    const { root } = pnpmRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), "warden-elsewhere-"));
    const later = resultsFile([fails("b")], join(elsewhere, "later.jsonl"));

    const line = await printedRerun([IN_RESULTS[0], later], { INIT_CWD: root });

    expect(dirname((await lineEnv(line)).WARDEN_EVAL_RESULTS!)).toBe(elsewhere);
  });

  it("starts a local line with eval:regressions' own WARDEN_EVAL_LOCAL_URL", async () => {
    const { root } = pnpmRoot();

    const line = await printedRerun(IN_RESULTS, {
      INIT_CWD: root,
      WARDEN_EVAL_LOCAL_URL: "http://127.0.0.1:9999/v1",
    });

    expect(line.split(" ")[0]).toBe("WARDEN_EVAL_LOCAL_URL=http://127.0.0.1:9999/v1");
  });

  it.each([
    ["unset", {}],
    ["blank", { WARDEN_EVAL_LOCAL_URL: "   " }],
  ])(
    "starts a local line with Ollama's default URL when WARDEN_EVAL_LOCAL_URL is %s",
    async (_, url) => {
      const { root } = pnpmRoot();

      const line = await printedRerun(IN_RESULTS, { INIT_CWD: root, ...url });

      expect(line.split(" ")[0]).toBe(`WARDEN_EVAL_LOCAL_URL=${DEFAULT_LOCAL_URL}`);
    },
  );
});
