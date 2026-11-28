// The Judge eval's harness (spec #225, slice 10b): each case replayed through the hook endpoint of a local Warden,
// as Claude Code's managed hook posts it, then judged by the real Judge on the real stores, and its result added to
// the results file before the next case. Each case gets a Team of its own, at the case's Privacy tier, so no case
// reads another's events, Findings or spending. Cases run one at a time, the local models first, then OpenRouter's.
//
// A run carries on from its results file: a (model, case) saved without an error isn't run again. Before each local
// model's first case, the other local models are unloaded, so one model's memory doesn't slow the next; Ollama itself
// is never started, stopped or reconfigured. OpenRouter's calls are paid: the harness keeps its own ledger under
// EVAL_PAID_CAP_USD, and stops before a case that could pass it.
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Status } from "@warden/contracts";
import { createFindings } from "../../src/findings/index.ts";
import { callJson, failureCode, type Fetch } from "../../src/http-call.ts";
import { createLogger } from "../../src/log.ts";
import { createAgentSessions } from "../../src/modules/guard/agent-sessions.ts";
import { hookEventRoutes } from "../../src/modules/guard/hook-event-routes.ts";
import { createHookSettings } from "../../src/modules/guard/hook-settings.ts";
import {
  createJudge,
  JUDGE_RUN_CALL_BUDGET,
  mayBeBilled,
  type JudgeRunOutcome,
} from "../../src/modules/guard/judge.ts";
import {
  localModel,
  ModelCallFailed,
  openRouterModel,
  type JudgeModel,
} from "../../src/modules/guard/judge-model.ts";
import { JUDGE_RULES } from "../../src/modules/guard/judge-rules.ts";
import { HOOK_EVENTS_PATH, managedSettings } from "../../src/modules/guard/managed-settings.ts";
import { createSpending, UNPRICED_CALL_USD } from "../../src/spending.ts";
import { MOVE_RULES } from "../../src/wiring.ts";
import type { WithTeam } from "../../src/with-team.ts";
import { ADMIN, newTeam, testApp, testKey } from "../helpers.ts";
import type { EvalCase } from "./eval-cases.ts";
import {
  appendResult,
  caseVerdict,
  latestResults,
  modelKey,
  readResults,
  resultKey,
  type EvalResultLine,
} from "./results.ts";
import type { EvalModel, EvalSettings } from "./settings.ts";

/** How long one local model call may take: a model on a laptop is slow, and the Judge's own minute is too short. */
export const EVAL_LOCAL_CALL_TIMEOUT_MS = 10 * 60_000;

/** The most a run spends on OpenRouter, counting what the results file already spent. */
export const EVAL_PAID_CAP_USD = 5;

/** What a paid case is taken to cost before any has been saved: every call of the run's budget, unpriced. */
export const FIRST_PAID_CASE_USD = UNPRICED_CALL_USD * JUDGE_RUN_CALL_BUDGET;

/** How long Ollama may take to unload a model. */
const UNLOAD_TIMEOUT_MS = 60_000;

/** The developer every replayed event names. */
const DEVELOPER = "dev";

export type RunEvalOptions = {
  settings: EvalSettings;
  /** The whole case set: the settings pick the cases run, and every saved line must name one of them. */
  cases: readonly EvalCase[];
  withTeam: WithTeam;
  /** OpenRouter's fetch: a test's fake. */
  openRouterFetch?: Fetch;
  /** Called as each case starts on a model, before its first event is posted. */
  onCase?: (c: EvalCase, model: EvalModel) => void;
  /** Where each case's line and the cap's stop are printed. */
  log?: (line: string) => void;
};

export type EvalRun = {
  /** Every line in the results file after the run, the earlier runs' first. */
  results: EvalResultLine[];
  /** The lines this run added. */
  ran: EvalResultLine[];
  /** Set when the run stopped at the paid cap: what OpenRouter's calls had cost, and the line printed. */
  capped: { spentUsd: number; message: string } | undefined;
};

/** The cases the settings pick, in the case set's order: the split's, then only those named. */
export function selectCases(cases: readonly EvalCase[], settings: EvalSettings): EvalCase[] {
  return cases.filter(
    (c) =>
      (settings.split === "all" || c.split === settings.split) &&
      (settings.caseNames === undefined || settings.caseNames.includes(c.name)),
  );
}

/** The paid calls' spending: what was spent, and the most one paid case has cost on each model (by `modelKey`). */
type Ledger = { spentUsd: number; mostCaseUsd: Map<string, number> };

/** What the next paid case on `model` is taken to cost: the most one has cost on it, and never under the first's. */
const nextCaseUsd = (ledger: Ledger, model: EvalModel) =>
  Math.max(ledger.mostCaseUsd.get(modelKey(model)) ?? 0, FIRST_PAID_CASE_USD);

/** Adds a paid case's cost to what the most one has cost on its model. */
function noteCase(ledger: Ledger, result: EvalResultLine): void {
  const key = modelKey(result);
  ledger.mostCaseUsd.set(key, Math.max(ledger.mostCaseUsd.get(key) ?? 0, result.cost_usd));
}

/** What one call cost and stated. */
type CallRecord = { inputTokens?: number; outputTokens?: number; costUsd: number };

/** A case the harness stopped after its model calls: its line, saving what they cost, and the harness's error. */
class CaseAbandoned extends Error {
  readonly line: EvalResultLine;
  readonly error: unknown;
  constructor(line: EvalResultLine, error: unknown) {
    super(line.error ?? "the case was abandoned");
    this.line = line;
    this.error = error;
  }
}

/**
 * `model`, with each call's tokens and cost added to `calls`, and a paid call's cost to `ledger`: what its answer
 * stated, or UNPRICED_CALL_USD for an answer stating none or a failure that may have been billed.
 */
function metered(model: JudgeModel, calls: CallRecord[], ledger: Ledger): JudgeModel {
  const charge = (record: CallRecord) => {
    calls.push(record);
    ledger.spentUsd += record.costUsd;
  };
  return {
    model: model.model,
    paid: model.paid,
    async complete(messages, schema) {
      let answer;
      try {
        answer = await model.complete(messages, schema);
      } catch (error) {
        charge({ costUsd: model.paid && mayBeBilled(error) ? UNPRICED_CALL_USD : 0 });
        throw error;
      }
      const { inputTokens, outputTokens, costUsd } = answer.usage ?? {};
      charge({
        inputTokens,
        outputTokens,
        costUsd: model.paid ? (costUsd ?? UNPRICED_CALL_USD) : 0,
      });
      return answer;
    },
  };
}

/** The calls' stated counts added up, or null when no call stated one. */
function stated(values: readonly (number | undefined)[]): number | null {
  const known = values.filter((value) => value !== undefined);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

/** The hook events a Team at `tier` sends: those the managed-settings block has a hook for. The replay shares it. */
export const hookEventsSentAt = (tier: EvalCase["tier"]) =>
  new Set(Object.keys(managedSettings({ url: "http://127.0.0.1", token: null, tier }).hooks));

/** The model a run's `model` names, with no tracing. */
function judgeModelFor(evalModel: EvalModel, openRouterFetch: Fetch | undefined): JudgeModel {
  if (evalModel.provider === "local")
    return localModel({
      url: evalModel.url,
      model: evalModel.model,
      timeoutMs: EVAL_LOCAL_CALL_TIMEOUT_MS,
      allowLocalhost: true,
    });
  return openRouterModel({
    apiKey: evalModel.apiKey,
    model: evalModel.model,
    ...(openRouterFetch === undefined ? {} : { fetch: openRouterFetch }),
  });
}

/**
 * Unloads every local model but `keep`, through Ollama's `POST /api/generate` with `keep_alive: 0` at the origin of
 * each one's URL; throws naming the model at a non-2xx answer or a connection error.
 */
async function unloadOthers(settings: EvalSettings, keep: string): Promise<void> {
  for (const other of settings.models) {
    if (other.provider !== "local" || other.model === keep) continue;
    const { model } = other;
    const origin = new URL(other.url).origin;
    const why = `before ${keep}'s first case, unloading ${model}`;
    let answer;
    try {
      answer = await callJson(globalThis.fetch, {
        step: why,
        url: `${origin}/api/generate`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, keep_alive: 0 }),
        },
        timeoutMs: UNLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(`${why} failed: ${failureCode(error) ?? "an error"}`, { cause: error });
    }
    if (!answer.ok) throw new Error(`${why} answered ${answer.status}`);
  }
}

/** A local Warden with the hook endpoint and no Judge job, served on 127.0.0.1, and what each case's run needs. */
async function startWarden(withTeam: WithTeam) {
  const { publicPem } = await testKey();
  const hookSettings = createHookSettings({ withTeam });
  const agentSessions = createAgentSessions({ withTeam });
  const findings = createFindings({ withTeam, moveRules: MOVE_RULES });
  const spending = createSpending({ withTeam });
  const { app } = testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      hookEventRoutes({
        hookSettings,
        agentSessions,
        pseudonymKey: randomBytes(32),
        behindCloudRun: false,
        logger: createLogger(() => {}),
      }),
    ],
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(started),
    );
  });
  const hookUrl = new URL(
    HOOK_EVENTS_PATH,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  ).href;
  const judgeRules = JUDGE_RULES.map(({ ruleId }) => ruleId);

  /** The Judge Rules with a Finding of any Status on the session's Asset, sorted. */
  async function flaggedRules(team: string, sessionId: string): Promise<string[]> {
    const found = await findings.listByRules(team, { rules: judgeRules, statuses: Status.options });
    const rules = found
      .filter(({ asset }) => asset.kind === "agent_session" && asset.ref === sessionId)
      .map(({ rule_id }) => rule_id);
    return [...new Set(rules)].sort();
  }

  /** One case on one model: a new Team, its events posted, the Judge run, and the result. */
  async function runCase(
    c: EvalCase,
    model: EvalModel,
    judgeModel: JudgeModel,
    ledger: Ledger,
  ): Promise<EvalResultLine> {
    const team = await newTeam(withTeam);
    const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });
    await hookSettings.setPrivacyTier(team, { tier: c.tier, setBy: ADMIN });
    const sessionId = `eval-${randomUUID()}`;
    const sent = hookEventsSentAt(c.tier);
    const startedAt = performance.now();
    for (const [i, event] of c.events.entries()) {
      if (!sent.has(event.hook_event_name)) continue;
      const response = await fetch(hookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Warden-Developer": DEVELOPER,
        },
        body: JSON.stringify({ session_id: sessionId, ...event }),
      });
      await response.arrayBuffer();
      if (response.status !== 204)
        throw new Error(
          `case "${c.name}": events[${i}] (${event.hook_event_name}) answered ${response.status}, not 204`,
        );
    }

    const calls: CallRecord[] = [];
    /** The case's line: what the Judge flagged and how it ended, with what its calls stated and cost. */
    const line = (
      flagged: string[],
      judged: Extract<JudgeRunOutcome, { kind: "judged" }> | undefined,
      error: string | null,
    ): EvalResultLine => {
      const outcome = judged?.outcome ?? null;
      return {
        model: model.model,
        provider: model.provider,
        case: c.name,
        group: c.group,
        split: c.split,
        labels: c.labels,
        flagged,
        ...caseVerdict({ labels: c.labels, flagged, error, outcome }),
        outcome,
        input_tokens: stated(calls.map((call) => call.inputTokens)),
        output_tokens: stated(calls.map((call) => call.outputTokens)),
        cost_usd: calls.reduce((total, call) => total + call.costUsd, 0),
        calls: calls.length,
        events_read: judged?.eventsRead ?? null,
        events_cut: judged?.eventsCut ?? null,
        ms: Math.round(performance.now() - startedAt),
        error,
        at: new Date().toISOString(),
      };
    };
    const judge = createJudge({
      agentSessions,
      findings,
      spending,
      modelFor: () => Promise.resolve(metered(judgeModel, calls, ledger)),
    });
    try {
      let ran: JudgeRunOutcome | undefined;
      let error: string | null = null;
      try {
        ran = await judge.run(team, sessionId);
      } catch (thrown) {
        // A model call that failed is the model's result; anything else is the harness's own fault, and stops the run.
        if (!(thrown instanceof ModelCallFailed)) throw thrown;
        error = thrown.message;
      }
      const judged = ran?.kind === "judged" ? ran : undefined;
      if (ran !== undefined && judged === undefined) error = ran.kind;
      return line(await flaggedRules(team, sessionId), judged, error);
    } catch (thrown) {
      // The harness stopped after the case's calls: a line keeps what they cost, so a resumed run's ledger has it.
      if (calls.length === 0) throw thrown;
      const why = thrown instanceof Error ? thrown.message : String(thrown);
      throw new CaseAbandoned(line([], undefined, `the harness stopped: ${why}`), thrown);
    }
  }

  return {
    runCase,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * Opens the results file `file` for appending and closes it again (creating it, empty, when it's new), so a file that
 * can't be written stops the run before its first model call, not after a paid one whose cost it then can't save.
 */
function checkWritable(file: string): void {
  try {
    closeSync(openSync(file, "a"));
  } catch (error) {
    const why = failureCode(error) ?? "an error";
    throw new Error(
      `WARDEN_EVAL_RESULTS names ${file}, which can't be opened for appending (${why})`,
      { cause: error },
    );
  }
}

/**
 * The run: the settings' cases on each of its models, each result added to the results file as it ends. Throws before
 * any case when the split and the case list select no case, at a results file that can't be opened for appending, and
 * at a bad saved line or one naming a case not in the set; it stops the run at an event not answered 204, a
 * failed unload or any error but a model call's; a case stopped after its model calls is saved first, with an error,
 * so a resumed run counts what they cost and runs it again. Answers `capped` when it stopped at the paid cap.
 */
export async function runEval({
  settings,
  cases,
  withTeam,
  openRouterFetch,
  onCase = () => {},
  log = console.log,
}: RunEvalOptions): Promise<EvalRun> {
  const selected = selectCases(cases, settings);
  if (selected.length === 0)
    throw new Error("WARDEN_EVAL_SPLIT and WARDEN_EVAL_CASES select no case");
  const file = settings.resultsFile;
  checkWritable(file);
  const saved = readResults(file);
  const names = new Set(cases.map(({ name }) => name));
  const stray = saved.find((result) => !names.has(result.case));
  if (stray !== undefined)
    throw new Error(`${file} holds a result for "${stray.case}", which isn't a case`);
  const done = new Set(
    latestResults(saved)
      .filter((result) => result.error === null)
      .map(resultKey),
  );
  const ledger: Ledger = { spentUsd: 0, mostCaseUsd: new Map() };
  for (const result of saved.filter(({ provider }) => provider === "openrouter")) {
    ledger.spentUsd += result.cost_usd;
    noteCase(ledger, result);
  }
  const results = [...saved];
  const ran: EvalResultLine[] = [];

  const warden = await startWarden(withTeam);
  try {
    for (const model of settings.models) {
      const todo = selected.filter(
        (c) => !done.has(resultKey({ provider: model.provider, model: model.model, case: c.name })),
      );
      if (todo.length === 0) continue;
      if (model.provider === "local") await unloadOthers(settings, model.model);
      const judgeModel = judgeModelFor(model, openRouterFetch);
      for (const c of todo) {
        if (model.provider === "openrouter") {
          const next = nextCaseUsd(ledger, model);
          if (ledger.spentUsd + next > EVAL_PAID_CAP_USD) {
            const message =
              `stopped before ${c.name} on ${model.model}: ${usd(ledger.spentUsd)} spent on OpenRouter, ` +
              `and a case may cost ${usd(next)}, over the ${usd(EVAL_PAID_CAP_USD)} cap`;
            log(message);
            return { results, ran, capped: { spentUsd: ledger.spentUsd, message } };
          }
        }
        onCase(c, model);
        let result: EvalResultLine;
        try {
          result = await warden.runCase(c, model, judgeModel, ledger);
        } catch (error) {
          if (!(error instanceof CaseAbandoned)) throw error;
          appendResult(file, error.line);
          throw error.error;
        }
        appendResult(file, result);
        // Each (model, case) runs once a run, even on a model named twice.
        done.add(resultKey(result));
        results.push(result);
        ran.push(result);
        if (model.provider === "openrouter") noteCase(ledger, result);
        log(
          `${model.provider} ${model.model} ${c.name}: ${result.pass ? "pass" : "FAIL"}` +
            ` (${result.error ?? result.outcome}, ${result.ms} ms)`,
        );
      }
    }
  } finally {
    await warden.close();
  }
  return { results, ran, capped: undefined };
}
