import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fakeLangfuse, traceOf } from "../test/fake-langfuse.ts";
import { neverAnswers } from "../test/fake-openrouter.ts";
import { createTracer, TRACE_TIMEOUT_MS, TraceNotSent, type JudgeTrace } from "./langfuse.ts";

const KEYS = { publicKey: "pk-lf-test", secretKey: "sk-lf-test" };
const BASE_URL = "https://langfuse.test";

const RUN: JudgeTrace = {
  team: "team-1",
  outcome: "flagged",
  calls: [
    {
      model: "test/judge-model",
      inputTokens: null,
      outputTokens: null,
      costUsd: 0.01,
      startedAt: new Date("2026-11-27T10:00:00.000Z"),
      endedAt: new Date("2026-11-27T10:00:01.500Z"),
      outcome: "failed",
    },
    {
      model: "test/judge-model",
      inputTokens: 1200,
      outputTokens: 80,
      costUsd: 0.0042,
      startedAt: new Date("2026-11-27T10:00:02.000Z"),
      endedAt: new Date("2026-11-27T10:00:03.250Z"),
      outcome: "answered",
    },
  ],
};

/** A local port nothing listens on: one the system handed out, then closed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The error `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("it resolved");
}

describe("createTracer", () => {
  it("posts one OTLP/HTTP JSON trace to Langfuse's trace endpoint with Basic auth and ingestion version 4", async () => {
    const fake = fakeLangfuse();
    await createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch }).sendJudgeRun(RUN);

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
    expect(call!.headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    );
    expect(call!.headers.get("Content-Type")).toBe("application/json");
    expect(call!.headers.get("x-langfuse-ingestion-version")).toBe("4");
  });

  it("holds a root span with the Team and the run's outcome, from the first call's start to the last one's end", async () => {
    const fake = fakeLangfuse();
    await createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch }).sendJudgeRun(RUN);

    const { root, generations } = traceOf(fake.calls[0]!);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.attributes).toEqual({
      "langfuse.trace.name": "judge-run",
      "langfuse.trace.metadata.team": "team-1",
      "langfuse.trace.metadata.outcome": "flagged",
    });
    expect(root.startTimeUnixNano).toBe(`${Date.parse("2026-11-27T10:00:00.000Z")}000000`);
    expect(root.endTimeUnixNano).toBe(`${Date.parse("2026-11-27T10:00:03.250Z")}000000`);
    expect(generations.map((span) => span.traceId)).toEqual([root.traceId, root.traceId]);
  });

  it("holds one generation per call with its model, tokens, cost, times and outcome, and no tokens it didn't state", async () => {
    const fake = fakeLangfuse();
    await createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch }).sendJudgeRun(RUN);

    const { generations } = traceOf(fake.calls[0]!);
    expect(generations.map((span) => span.attributes)).toEqual([
      {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": "test/judge-model",
        "langfuse.observation.usage_details": "{}",
        "langfuse.observation.cost_details": JSON.stringify({ total: 0.01 }),
        "langfuse.observation.metadata.outcome": "failed",
      },
      {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": "test/judge-model",
        "langfuse.observation.usage_details": JSON.stringify({ input: 1200, output: 80 }),
        "langfuse.observation.cost_details": JSON.stringify({ total: 0.0042 }),
        "langfuse.observation.metadata.outcome": "answered",
      },
    ]);
    expect(generations[1]!.startTimeUnixNano).toBe(
      `${Date.parse("2026-11-27T10:00:02.000Z")}000000`,
    );
    expect(generations[1]!.endTimeUnixNano).toBe(`${Date.parse("2026-11-27T10:00:03.250Z")}000000`);
  });

  it("copies only the fields its input names: anything else passed to it is never sent", async () => {
    const fake = fakeLangfuse();
    const marker = "planted-not-a-trace-field";
    const smuggled = {
      ...RUN,
      sessionId: marker,
      calls: RUN.calls.map((call) => ({ ...call, prompt: marker })),
    };
    await createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch }).sendJudgeRun(smuggled);

    expect(fake.calls[0]!.text).not.toContain(marker);
  });

  it("throws TraceNotSent with the status alone when Langfuse answers non-2xx", async () => {
    const fake = fakeLangfuse(() =>
      Response.json({ message: "secret-ish detail" }, { status: 500 }),
    );
    const error = await rejection(
      createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch }).sendJudgeRun(RUN),
    );

    expect(error).toBeInstanceOf(TraceNotSent);
    expect(error).toMatchObject({ status: 500, code: undefined });
  });

  it("throws TraceNotSent with the code timeout when Langfuse never answers within its timeout", async () => {
    const fake = fakeLangfuse(neverAnswers);
    const error = await rejection(
      createTracer({ ...KEYS, baseUrl: BASE_URL, fetch: fake.fetch, timeoutMs: 20 }).sendJudgeRun(
        RUN,
      ),
    );

    expect(error).toBeInstanceOf(TraceNotSent);
    expect(error).toMatchObject({ status: undefined, code: "timeout" });
    expect(TRACE_TIMEOUT_MS).toBe(5000);
  });

  it("throws TraceNotSent with the connection's error code when nothing listens", async () => {
    // A port that was free a moment ago, on this machine: fetch's own error, as a refused connection gives it.
    const error = await rejection(
      createTracer({
        ...KEYS,
        baseUrl: `https://127.0.0.1:${await freePort()}`,
        fetch,
      }).sendJudgeRun(RUN),
    );

    expect(error).toBeInstanceOf(TraceNotSent);
    expect(error).toMatchObject({ status: undefined, code: "ECONNREFUSED" });
  });
});
