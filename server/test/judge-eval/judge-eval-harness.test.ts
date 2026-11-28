// The Judge eval's harness (spec #225, slice 10b): each case replayed through the hook endpoint to a local Warden,
// judged, saved as one line and scored. Every model here is a fake: the Team's own model is `fakeModelServer` on
// 127.0.0.1, OpenRouter is `fakeOpenRouter`, so no call leaves the machine and nothing is paid for.
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { HOOK_BODY_LIMIT_BYTES } from "../../src/modules/guard/hook-event-routes.ts";
import { JUDGE_STEERING_TEXT } from "../../src/modules/guard/judge-rules.ts";
import { managedSettings } from "../../src/modules/guard/managed-settings.ts";
import { createWithTeam, type WithTeam } from "../../src/with-team.ts";
import { runCommand } from "../child-process.ts";
import { poolAs } from "../databases.ts";
import {
  closeFakeModelServers,
  completion,
  fakeModelServer,
  json,
  type Answer,
} from "../fake-model-server.ts";
import { fakeOpenRouter, verdict, withUsage } from "../fake-openrouter.ts";
import { loadEvalCases, type EvalCase } from "./eval-cases.ts";
import { EVAL_PAID_CAP_USD, FIRST_PAID_CASE_USD, runEval } from "./harness.ts";
import { appendResult, readResults, type EvalResultLine } from "./results.ts";
import { readEvalSettings } from "./settings.ts";

const CASES = loadEvalCases();
const NAMES = CASES.map(({ name }) => name);
const KEY = "sk-or-v1-planted-key-value";
const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Each case Warden's own steering patterns flag with guard/judge-steering-text though it isn't labelled so: with a
 * verdict naming only its labels, these alone fail, flagged beyond them. */
const STEERED_BEYOND_LABELS = ["near-miss-ai-reviewer", "near-miss-reads-steering-tests"];

/** A run's variables: one local model and its URL, and a results file, with `extra` over them. */
const env = (extra: Record<string, string | undefined> = {}) => ({
  WARDEN_EVAL_LOCAL_URL: "http://127.0.0.1:11434/v1",
  WARDEN_EVAL_LOCAL_MODELS: "qwen3:8b",
  WARDEN_EVAL_RESULTS: "results.jsonl",
  ...extra,
});

/** The message `readEvalSettings` throws for `variables`. */
function refusal(variables: Record<string, string | undefined>): string {
  try {
    readEvalSettings(variables, NAMES);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("readEvalSettings took the settings");
}

describe("readEvalSettings: the run's variables, checked before any case", () => {
  it("reads the local models before the OpenRouter ones, each comma list trimmed", () => {
    const settings = readEvalSettings(
      env({
        WARDEN_EVAL_LOCAL_MODELS: " qwen3:8b, gemma3:12b ,",
        WARDEN_EVAL_OPENROUTER_MODELS: "anthropic/claude-haiku-5.5",
        OPENROUTER_API_KEY: KEY,
      }),
      NAMES,
    );

    const url = "http://127.0.0.1:11434/v1";
    expect(settings.models).toEqual([
      { provider: "local", model: "qwen3:8b", url },
      { provider: "local", model: "gemma3:12b", url },
      { provider: "openrouter", model: "anthropic/claude-haiku-5.5", apiKey: KEY },
    ]);
    expect(settings).toMatchObject({ split: "all", caseNames: undefined });
  });

  it("names the same model under two providers as two models", () => {
    const settings = readEvalSettings(
      env({ WARDEN_EVAL_OPENROUTER_MODELS: "qwen3:8b", OPENROUTER_API_KEY: KEY }),
      NAMES,
    );

    expect(settings.models.map(({ provider, model }) => [provider, model])).toEqual([
      ["local", "qwen3:8b"],
      ["openrouter", "qwen3:8b"],
    ]);
  });

  it("finds a relative results file from where pnpm was run, not from server/", () => {
    expect(
      readEvalSettings(env({ INIT_CWD: "/work", WARDEN_EVAL_RESULTS: "evals/r.jsonl" }), NAMES)
        .resultsFile,
    ).toBe("/work/evals/r.jsonl");
    expect(readEvalSettings(env(), NAMES).resultsFile).toBe(join(process.cwd(), "results.jsonl"));
    expect(
      readEvalSettings(env({ INIT_CWD: "/work", WARDEN_EVAL_RESULTS: "/tmp/r.jsonl" }), NAMES)
        .resultsFile,
    ).toBe("/tmp/r.jsonl");
  });

  it("takes a split and a list of cases", () => {
    const settings = readEvalSettings(
      env({ WARDEN_EVAL_SPLIT: "held-out", WARDEN_EVAL_CASES: `${NAMES[1]}, ${NAMES[0]}` }),
      NAMES,
    );

    expect(settings.split).toBe("held-out");
    expect(settings.caseNames).toEqual([NAMES[1], NAMES[0]]);
  });

  it.each([
    [
      "no model",
      { WARDEN_EVAL_LOCAL_MODELS: undefined },
      /WARDEN_EVAL_LOCAL_MODELS or WARDEN_EVAL_OPENROUTER_MODELS/,
    ],
    ["local models with no URL", { WARDEN_EVAL_LOCAL_URL: undefined }, /WARDEN_EVAL_LOCAL_URL/],
    ["a local URL that isn't one", { WARDEN_EVAL_LOCAL_URL: "not a url" }, /WARDEN_EVAL_LOCAL_URL/],
    [
      "OpenRouter models with no key",
      { WARDEN_EVAL_OPENROUTER_MODELS: "anthropic/claude-haiku-5.5" },
      /OPENROUTER_API_KEY/,
    ],
    ["no results file", { WARDEN_EVAL_RESULTS: undefined }, /WARDEN_EVAL_RESULTS/],
    ["an unknown split", { WARDEN_EVAL_SPLIT: "train" }, /WARDEN_EVAL_SPLIT.*"train"/],
    [
      "an unknown case",
      { WARDEN_EVAL_CASES: `${NAMES[0]},no-such-case` },
      /WARDEN_EVAL_CASES.*"no-such-case"/,
    ],
    ["an empty list of cases", { WARDEN_EVAL_CASES: "" }, /^WARDEN_EVAL_CASES names no case$/],
    ["a list of cases that names none", { WARDEN_EVAL_CASES: " , " }, /names no case/],
    [
      "a local model named twice",
      { WARDEN_EVAL_LOCAL_MODELS: "qwen3:8b, gemma3:12b,qwen3:8b" },
      /^WARDEN_EVAL_LOCAL_MODELS names qwen3:8b twice$/,
    ],
    [
      "an OpenRouter model named twice",
      { WARDEN_EVAL_OPENROUTER_MODELS: "a/b,a/b", OPENROUTER_API_KEY: KEY },
      /WARDEN_EVAL_OPENROUTER_MODELS names a\/b twice/,
    ],
  ])("refuses %s, naming the variable", (_, change, named) => {
    expect(refusal(env(change))).toMatch(named);
  });

  it("never names the key's value", () => {
    const messages = [
      refusal(env({ OPENROUTER_API_KEY: KEY, WARDEN_EVAL_RESULTS: undefined })),
      refusal(env({ OPENROUTER_API_KEY: KEY, WARDEN_EVAL_SPLIT: "train" })),
      refusal({ OPENROUTER_API_KEY: KEY }),
    ];

    expect(messages.filter((message) => message.includes(KEY))).toEqual([]);
  });
});

let pool: pg.Pool;
let withTeam: WithTeam;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
});

afterAll(() => pool.end());
afterEach(closeFakeModelServers);

/** A new, empty results file's path. */
const resultsPath = () => join(mkdtempSync(join(tmpdir(), "warden-eval-")), "results.jsonl");

/** The case a run is on, set as each case starts. */
let current: EvalCase | undefined;

/** The verdict naming `c`'s labels, each citing the session's first event. */
const labelled = (c: EvalCase) =>
  c.labels.map((rule_id) => ({
    rule_id,
    summary: `The session broke ${rule_id}.`,
    event_seqs: [0],
  }));

/** A chat completion naming the current case's labels. */
const namesLabels: Answer = (res, req) =>
  completion(JSON.stringify({ broken_rules: labelled(current!) }))(res, req);

/** A fake Ollama on 127.0.0.1: `unload` answers `POST /api/generate`, `chat` each chat call. */
async function fakeOllama(chat: Answer = namesLabels, unload: Answer = json(200, { done: true })) {
  const server = await fakeModelServer((res, req) =>
    (req.url === "/api/generate" ? unload : chat)(res, req),
  );
  return {
    ...server,
    url: `http://127.0.0.1:${server.port}/v1`,
    chats: () => server.received.filter(({ url }) => url === "/v1/chat/completions"),
  };
}

/** One run over the case set with `variables`, keeping each case it started and each line it printed. */
async function run(
  variables: Record<string, string | undefined>,
  options: Partial<Parameters<typeof runEval>[0]> = {},
) {
  const started: string[] = [];
  const printed: string[] = [];
  const result = await runEval({
    settings: readEvalSettings(variables, NAMES),
    cases: CASES,
    withTeam,
    onCase: (c, model) => {
      current = c;
      started.push(`${model.model} ${c.name}`);
    },
    log: (line) => printed.push(line),
    ...options,
  });
  return { ...result, started, printed };
}

/** The variables for a run on the fake Ollama `ollama`, saving to `file`. */
const onOllama = (ollama: { url: string }, file: string, extra = {}) =>
  env({ WARDEN_EVAL_LOCAL_URL: ollama.url, WARDEN_EVAL_RESULTS: file, ...extra });

/** The events the case's tier sends. */
const sentEvents = (c: EvalCase) => {
  const sent = Object.keys(managedSettings({ url: "http://x", token: null, tier: c.tier }).hooks);
  return c.events.filter((event) => sent.includes(event.hook_event_name));
};

const byName = (name: string) => CASES.find((c) => c.name === name)!;

describe("runEval: each case replayed through the hook, judged and saved", () => {
  it("runs every case to its verdict, one chat call and one saved line each", async () => {
    const ollama = await fakeOllama();
    const file = resultsPath();

    const { results, ran } = await run(onOllama(ollama, file));

    expect(readResults(file)).toEqual(ran);
    expect(results).toEqual(ran);
    expect(ran.map((result) => result.case)).toEqual(NAMES);
    expect(ollama.chats()).toHaveLength(CASES.length);
    // Every event the tier sends was stored, so each answered 204.
    expect(ran.map((result) => (result.events_read ?? 0) + (result.events_cut ?? 0))).toEqual(
      CASES.map((c) => sentEvents(c).length),
    );
    expect(ran.filter((result) => !result.pass).map((result) => result.case)).toEqual(
      STEERED_BEYOND_LABELS,
    );
    expect(
      ran.filter((result) => !result.pass).map(({ extra, missing }) => ({ extra, missing })),
    ).toEqual(STEERED_BEYOND_LABELS.map(() => ({ extra: [JUDGE_STEERING_TEXT], missing: [] })));
    expect(ran.filter((result) => result.pass).map((result) => result.flagged)).toEqual(
      CASES.filter((c) => !STEERED_BEYOND_LABELS.includes(c.name)).map((c) => c.labels.toSorted()),
    );
  }, 120_000);

  it("saves a refusal as needs_human_review, failing", async () => {
    const ollama = await fakeOllama(
      json(200, { choices: [{ message: { content: null, refusal: "I can't help with that." } }] }),
    );
    const file = resultsPath();

    await run(onOllama(ollama, file, { WARDEN_EVAL_CASES: "sends-secrets-plain-pastebin" }));

    expect(readResults(file)).toEqual([
      expect.objectContaining({
        case: "sends-secrets-plain-pastebin",
        outcome: "needs_human_review",
        pass: false,
        error: null,
        calls: 1,
        flagged: [],
      }),
    ]);
  });

  it("saves a call that fails twice with its error, unjudged", async () => {
    const ollama = await fakeOllama(json(500, {}));
    const file = resultsPath();

    await run(onOllama(ollama, file, { WARDEN_EVAL_CASES: "sends-secrets-plain-pastebin" }));

    const [saved] = readResults(file);
    expect(saved).toMatchObject({
      outcome: null,
      pass: false,
      error: "the Judge's model call answered 500",
      calls: 2,
      events_read: null,
      events_cut: null,
      cost_usd: 0,
    });
  });

  it("stops at an event not answered 204, naming the case, the event and the status", async () => {
    const ollama = await fakeOllama();
    const c = byName("sends-secrets-plain-pastebin");
    const at = c.events.findIndex((event) => event.hook_event_name === "PostToolUse");
    const padded = {
      ...c,
      events: c.events.map((event, i) =>
        i === at ? { ...event, padding: "x".repeat(HOOK_BODY_LIMIT_BYTES) } : event,
      ),
    };

    await expect(
      run(onOllama(ollama, resultsPath(), { WARDEN_EVAL_CASES: c.name }), { cases: [padded] }),
    ).rejects.toThrow(`case "${c.name}": events[${at}] (PostToolUse) answered 413, not 204`);
    expect(ollama.chats()).toEqual([]);
  });
});

describe("runEval: which cases a run takes", () => {
  const two = ["destructive-plain-force-push", "ordinary-short-readme-summary"];

  it("takes the held-out split's 12 cases", async () => {
    const { ran } = await run(
      onOllama(await fakeOllama(), resultsPath(), { WARDEN_EVAL_SPLIT: "held-out" }),
    );

    expect(ran).toHaveLength(12);
    expect(ran.every((result) => result.split === "held-out")).toBe(true);
  });

  it("takes the cases named, and only them", async () => {
    const { ran } = await run(
      onOllama(await fakeOllama(), resultsPath(), { WARDEN_EVAL_CASES: two.join(",") }),
    );

    expect(ran.map((result) => result.case)).toEqual(two);
  });

  it("resumes: runs only the cases not saved, and reruns one saved with an error", async () => {
    const [a, b, c, d] = [
      "destructive-plain-force-push",
      "near-miss-rm-dist",
      "ordinary-short-readme-summary",
      "reads-secrets-plain-env",
    ] as const; // in the case set's order, which a run keeps
    const file = resultsPath();
    const failsOnB: Answer = (res, req) =>
      (current!.name === b ? json(500, {}) : namesLabels)(res, req);
    await run(
      onOllama(await fakeOllama(failsOnB), file, { WARDEN_EVAL_CASES: [a, b, c].join(",") }),
    );

    const ollama = await fakeOllama();
    const resumed = await run(
      onOllama(ollama, file, { WARDEN_EVAL_CASES: [a, b, c, d].join(",") }),
    );

    expect(resumed.started).toEqual([`qwen3:8b ${b}`, `qwen3:8b ${d}`]);
    expect(ollama.chats()).toHaveLength(2);
    expect(readResults(file).map(({ case: name, error }) => [name, error !== null])).toEqual([
      [a, false],
      [b, true],
      [c, false],
      [b, false],
      [d, false],
    ]);
  });

  it("runs a case once on a model the settings name twice", async () => {
    const ollama = await fakeOllama();
    const variables = onOllama(ollama, resultsPath(), { WARDEN_EVAL_CASES: two[0] });
    const settings = readEvalSettings(variables, NAMES);

    const { ran } = await run(variables, {
      settings: { ...settings, models: [settings.models[0]!, settings.models[0]!] },
    });

    expect(ran.map((result) => result.case)).toEqual([two[0]]);
    expect(ollama.chats()).toHaveLength(1);
  });

  it("stops before any case at a saved line that isn't JSON, naming its line", async () => {
    const ollama = await fakeOllama();
    const file = resultsPath();
    await run(onOllama(ollama, file, { WARDEN_EVAL_CASES: "near-miss-rm-dist" }));
    appendFileSync(file, "not json\n");

    const stopped = run(onOllama(ollama, file));

    await expect(stopped).rejects.toThrow(`${file} line 2 isn't JSON`);
    expect(ollama.chats()).toHaveLength(1);
  });

  it("stops before any case at a saved line for a case not in the set", async () => {
    const ollama = await fakeOllama();
    const file = resultsPath();
    await run(onOllama(ollama, file, { WARDEN_EVAL_CASES: "near-miss-rm-dist" }));
    const [saved] = readResults(file);
    appendFileSync(file, `${JSON.stringify({ ...saved, case: "retired-case" })}\n`);

    await expect(run(onOllama(ollama, file))).rejects.toThrow(/"retired-case".*isn't a case/);
    expect(ollama.chats()).toHaveLength(1);
  });
});

describe("runEval: what it checks before any model call", () => {
  it("stops at a results file in a folder that doesn't exist, naming WARDEN_EVAL_RESULTS and the path", async () => {
    const ollama = await fakeOllama();
    const file = join(mkdtempSync(join(tmpdir(), "warden-eval-")), "missing", "results.jsonl");

    await expect(run(onOllama(ollama, file))).rejects.toThrow(
      `WARDEN_EVAL_RESULTS names ${file}, which can't be opened for appending`,
    );
    expect(ollama.received).toEqual([]);
  });

  it("stops at a split and a list of cases that select no case together", async () => {
    const heldOut = CASES.find((c) => c.split === "held-out")!;
    const ollama = await fakeOllama();

    await expect(
      run(
        onOllama(ollama, resultsPath(), {
          WARDEN_EVAL_SPLIT: "dev",
          WARDEN_EVAL_CASES: heldOut.name,
        }),
      ),
    ).rejects.toThrow("WARDEN_EVAL_SPLIT and WARDEN_EVAL_CASES select no case");
    expect(ollama.received).toEqual([]);
  });
});

describe("runEval: unloading the other local models", () => {
  const variables = (ollama: { url: string }, file = resultsPath()) =>
    onOllama(ollama, file, {
      WARDEN_EVAL_LOCAL_MODELS: "model-a,model-b",
      WARDEN_EVAL_CASES: "near-miss-rm-dist",
    });

  it("unloads every other local model before each one's first case", async () => {
    const ollama = await fakeOllama();

    await run(variables(ollama));

    expect(ollama.received.map(({ url, body }) => [url, body.model, body.keep_alive])).toEqual([
      ["/api/generate", "model-b", 0],
      ["/v1/chat/completions", "model-a", undefined],
      ["/api/generate", "model-a", 0],
      ["/v1/chat/completions", "model-b", undefined],
    ]);
  });

  it("stops before a model's first case when an unload answers 500, naming the model", async () => {
    const ollama = await fakeOllama(namesLabels, json(500, {}));
    const file = resultsPath();

    await expect(run(variables(ollama, file))).rejects.toThrow(
      "before model-a's first case, unloading model-b answered 500",
    );
    expect(ollama.chats()).toEqual([]);
  });
});

describe("runEval: the paid cap", () => {
  const FIVE = NAMES.slice(0, 5);
  const paidVariables = (file: string, extra = {}) =>
    env({
      WARDEN_EVAL_LOCAL_URL: undefined,
      WARDEN_EVAL_LOCAL_MODELS: undefined,
      WARDEN_EVAL_OPENROUTER_MODELS: "test/paid-model",
      OPENROUTER_API_KEY: KEY,
      WARDEN_EVAL_RESULTS: file,
      WARDEN_EVAL_CASES: FIVE.join(","),
      ...extra,
    });
  /** OpenRouter, faked, naming the current case's labels at $1.50 a call. */
  const atOneFifty = () =>
    fakeOpenRouter(() =>
      withUsage(verdict(labelled(current!)), {
        prompt_tokens: 900,
        completion_tokens: 60,
        cost: 1.5,
      }),
    );

  it("stops before the case that would pass $5, printing what was spent and keeping the lines", async () => {
    const paid = atOneFifty();
    const file = resultsPath();

    const { ran, capped, printed } = await run(paidVariables(file), {
      openRouterFetch: paid.fetch,
    });

    expect(paid.calls).toHaveLength(3);
    expect(ran.map((result) => result.case)).toEqual(FIVE.slice(0, 3));
    expect(readResults(file).map((result) => result.cost_usd)).toEqual([1.5, 1.5, 1.5]);
    expect(capped?.spentUsd).toBeCloseTo(4.5);
    expect(capped!.spentUsd + 1.5).toBeGreaterThan(EVAL_PAID_CAP_USD);
    expect(printed.at(-1)).toContain("$4.50 spent");
    expect(readResults(file)[0]).toMatchObject({ input_tokens: 900, output_tokens: 60, calls: 1 });
  });

  it("runs no paid case on a resumed run already at the cap", async () => {
    const file = resultsPath();
    await run(paidVariables(file), { openRouterFetch: atOneFifty().fetch });
    const paid = atOneFifty();

    const { ran, capped } = await run(paidVariables(file), { openRouterFetch: paid.fetch });

    expect(paid.calls).toEqual([]);
    expect(ran).toEqual([]);
    expect(capped?.spentUsd).toBeCloseTo(4.5);
  });

  /** A saved line: `c` judged as labelled on the OpenRouter model `model`, costing `cost_usd`. */
  const savedPaid = (model: string, c: EvalCase, cost_usd: number): EvalResultLine => ({
    model,
    provider: "openrouter",
    case: c.name,
    group: c.group,
    split: c.split,
    labels: c.labels,
    flagged: c.labels.toSorted(),
    missing: [],
    extra: [],
    outcome: c.labels.length > 0 ? "flagged" : "clean",
    pass: true,
    input_tokens: null,
    output_tokens: null,
    cost_usd,
    calls: 1,
    events_read: 1,
    events_cut: 0,
    ms: 1,
    error: null,
    at: new Date().toISOString(),
  });

  it("estimates a model's next case from that model's own saved cases", async () => {
    const file = resultsPath();
    appendResult(file, savedPaid("test/dear-model", byName(FIVE[0]!), 3));
    appendResult(file, savedPaid("test/paid-model", byName(FIVE[0]!), 0.2));
    const paid = fakeOpenRouter(() =>
      withUsage(verdict(labelled(current!)), {
        prompt_tokens: 900,
        completion_tokens: 60,
        cost: 0.2,
      }),
    );

    const { ran, capped } = await run(paidVariables(file, { WARDEN_EVAL_CASES: FIVE[1] }), {
      openRouterFetch: paid.fetch,
    });

    expect(capped).toBeUndefined();
    expect(ran.map((result) => result.case)).toEqual([FIVE[1]]);
  });

  it("takes a paid case to cost at least FIRST_PAID_CASE_USD, though the model's saved cases cost nothing", async () => {
    const file = resultsPath();
    const spent = EVAL_PAID_CAP_USD - FIRST_PAID_CASE_USD / 2;
    appendResult(file, savedPaid("test/dear-model", byName(FIVE[0]!), spent));
    appendResult(file, savedPaid("test/paid-model", byName(FIVE[0]!), 0));
    const paid = atOneFifty();

    const { ran, capped } = await run(paidVariables(file, { WARDEN_EVAL_CASES: FIVE[1] }), {
      openRouterFetch: paid.fetch,
    });

    expect(paid.calls).toEqual([]);
    expect(ran).toEqual([]);
    expect(capped?.spentUsd).toBeCloseTo(spent);
  });

  it("saves what a case's paid calls cost when the run stops after them, so a resumed run counts it", async () => {
    const file = resultsPath();
    let broken = false;
    const breaksAfterACall: WithTeam = (team, work) =>
      broken ? Promise.reject(new Error("the database went away")) : withTeam(team, work);
    const breaking = fakeOpenRouter(() => {
      broken = true;
      return withUsage(verdict(labelled(current!)), {
        prompt_tokens: 900,
        completion_tokens: 60,
        cost: 1.5,
      });
    });

    await expect(
      run(paidVariables(file), { withTeam: breaksAfterACall, openRouterFetch: breaking.fetch }),
    ).rejects.toThrow("the database went away");

    expect(readResults(file)).toEqual([
      expect.objectContaining({
        case: FIVE[0],
        cost_usd: 1.5,
        calls: 1,
        pass: false,
        outcome: null,
        error: expect.stringContaining("the database went away"),
      }),
    ]);
    // $1.50 already spent: two more cases fit under $5, a third doesn't.
    const { ran, capped } = await run(paidVariables(file), { openRouterFetch: atOneFifty().fetch });
    expect(ran.map((result) => result.case)).toEqual(FIVE.slice(0, 2));
    expect(capped?.spentUsd).toBeCloseTo(4.5);
  });

  it("never counts a local model's calls, even one stating a cost", async () => {
    const stated: Answer = (res, req) =>
      json(
        200,
        withUsage(verdict(labelled(current!)), {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost: 2,
        }),
      )(res, req);
    const ollama = await fakeOllama(stated);
    const paid = atOneFifty();
    const file = resultsPath();

    await run(
      paidVariables(file, {
        WARDEN_EVAL_LOCAL_URL: ollama.url,
        WARDEN_EVAL_LOCAL_MODELS: "qwen3:8b",
        WARDEN_EVAL_CASES: FIVE.slice(0, 4).join(","),
      }),
      { openRouterFetch: paid.fetch },
    );

    const saved = readResults(file);
    expect(saved.filter((result) => result.provider === "local").map((r) => r.cost_usd)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(paid.calls).toHaveLength(3);
  });
});

describe("eval:judge's run file", () => {
  /** The run file under vitest, as `eval:judge` runs it, with `env` over this run's environment. */
  const runFile = (variables: Record<string, string | undefined>) =>
    runCommand(
      [process.execPath, "node_modules/vitest/vitest.mjs", "run", "test/judge-eval-run.test.ts"],
      { WARDEN_EVAL: undefined, ...variables },
      { cwd: SERVER_DIR },
    );

  it("skips without WARDEN_EVAL=1", async () => {
    const { code, output } = await runFile({});

    expect(code).toBe(0);
    expect(output).toMatch(/1 skipped/);
  }, 60_000);

  it("fails before any case with WARDEN_EVAL=1 and no model, naming the variables", async () => {
    const { code, output } = await runFile({
      WARDEN_EVAL: "1",
      WARDEN_EVAL_LOCAL_MODELS: undefined,
      WARDEN_EVAL_OPENROUTER_MODELS: undefined,
    });

    expect(code).not.toBe(0);
    expect(output).toContain("WARDEN_EVAL_LOCAL_MODELS or WARDEN_EVAL_OPENROUTER_MODELS");
  }, 60_000);
});
