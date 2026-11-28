// Langfuse traces, metadata only (spec #225, slice 7b, threat J7): what a Judge run's model calls cost and how they
// went, for the owner to watch spending and failures. Scans and chat will trace through it when they make model calls.
//
// One POST to Langfuse's OpenTelemetry endpoint as OTLP/HTTP JSON, with Basic auth: no SDK and no exporter (Langfuse's
// older ingestion API is sunset on Langfuse Cloud). The body is built field by field from `JudgeTrace`, which holds
// only the Team id, the outcomes, and each call's model, tokens, cost and times: never a prompt, an event, an answer,
// a summary, a session id or a developer, so nothing else handed to it can be sent.
import { randomBytes } from "node:crypto";
import { callJson, CallFailed, failureCode, type Fetch } from "./http-call.ts";

/** How long one trace may take to send: a run never waits longer on Langfuse. */
export const TRACE_TIMEOUT_MS = 5_000;

/** Langfuse's EU region, the default base URL. */
export const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

/** The keys and base URL `judgeSettings` reads from LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL. */
export type LangfuseSettings = { publicKey: string; secretKey: string; baseUrl: string };

/** One model call of a run: its model, tokens (null when unstated), cost in dollars, times and how it ended. */
export type TracedCall = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  startedAt: Date;
  endedAt: Date;
  outcome: "answered" | "refused" | "failed";
};

/** One Judge run that made at least one call: its Team, its outcome and its calls, in order. */
export type JudgeTrace = {
  team: string;
  outcome: "flagged" | "clean" | "needs_human_review" | "limited" | "failed";
  calls: readonly TracedCall[];
};

/** Why a trace wasn't sent: Langfuse's answer's status, or the connection's error code (`timeout` for a timeout). */
export type NotSentReason = { status: number } | { code: string };

/** A trace Langfuse didn't take; its `reason` is safe to log as is, never holding Langfuse's answer body. */
export class TraceNotSent extends Error {
  override name = "TraceNotSent";
  readonly reason: NotSentReason;
  constructor(reason: NotSentReason) {
    super(
      "status" in reason
        ? `Langfuse answered ${reason.status}`
        : `the trace wasn't sent: ${reason.code}`,
    );
    this.reason = reason;
  }
}

export interface Tracer {
  /** Sends the run's trace; throws TraceNotSent when Langfuse didn't take it. */
  sendJudgeRun(trace: JudgeTrace): Promise<void>;
}

type Attribute = { key: string; value: { stringValue: string } };
const attribute = (key: string, value: string): Attribute => ({
  key,
  value: { stringValue: value },
});

const nanos = (at: Date) => (BigInt(at.getTime()) * 1_000_000n).toString();
const hexId = (bytes: number) => randomBytes(bytes).toString("hex");

/** The OTLP/HTTP JSON body: a root span for the run, and a generation span per call under it. */
function otlpBody(trace: JudgeTrace) {
  const traceId = hexId(16);
  const rootId = hexId(8);
  const calls = trace.calls.map((call) => ({
    traceId,
    spanId: hexId(8),
    parentSpanId: rootId,
    name: "judge-call",
    kind: 1,
    startTimeUnixNano: nanos(call.startedAt),
    endTimeUnixNano: nanos(call.endedAt),
    attributes: [
      attribute("langfuse.observation.type", "generation"),
      attribute("langfuse.observation.model.name", call.model),
      attribute(
        "langfuse.observation.usage_details",
        JSON.stringify({
          ...(call.inputTokens === null ? {} : { input: call.inputTokens }),
          ...(call.outputTokens === null ? {} : { output: call.outputTokens }),
        }),
      ),
      attribute("langfuse.observation.cost_details", JSON.stringify({ total: call.costUsd })),
      attribute("langfuse.observation.metadata.outcome", call.outcome),
    ],
  }));
  const root = {
    traceId,
    spanId: rootId,
    name: "judge-run",
    kind: 1,
    startTimeUnixNano: calls[0]?.startTimeUnixNano ?? nanos(new Date()),
    endTimeUnixNano: calls.at(-1)?.endTimeUnixNano ?? nanos(new Date()),
    attributes: [
      attribute("langfuse.trace.name", "judge-run"),
      attribute("langfuse.trace.metadata.team", trace.team),
      attribute("langfuse.trace.metadata.outcome", trace.outcome),
    ],
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "warden")] },
        scopeSpans: [{ scope: { name: "warden-judge" }, spans: [root, ...calls] }],
      },
    ],
  };
}

/** Langfuse's OTLP trace endpoint under `baseUrl`, keeping any path it has (a self-hosted Langfuse under `/langfuse`). */
const tracesUrl = (baseUrl: string) =>
  new URL("api/public/otel/v1/traces", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

/** The tracer for Langfuse at `baseUrl`; tests hand it a fake `fetch` and a short timeout. */
export function createTracer({
  publicKey,
  secretKey,
  baseUrl,
  fetch = globalThis.fetch,
  timeoutMs = TRACE_TIMEOUT_MS,
}: LangfuseSettings & { fetch?: Fetch; timeoutMs?: number }): Tracer {
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const url = tracesUrl(baseUrl);
  return {
    async sendJudgeRun(trace) {
      let answer;
      try {
        answer = await callJson(fetch, {
          step: "send the Judge's trace",
          url,
          init: {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
              // Without it, Langfuse may take up to 10 minutes to show the trace.
              "x-langfuse-ingestion-version": "4",
            },
            body: JSON.stringify(otlpBody(trace)),
          },
          timeoutMs,
        });
      } catch (error) {
        // An answer came before its body was lost: a 2xx means Langfuse took the trace.
        if (error instanceof CallFailed && error.status !== undefined) {
          if (error.status >= 200 && error.status < 300) return;
          throw new TraceNotSent({ status: error.status });
        }
        throw new TraceNotSent({ code: failureCode(error) ?? "unknown" });
      }
      if (!answer.ok) throw new TraceNotSent({ status: answer.status });
    },
  };
}
