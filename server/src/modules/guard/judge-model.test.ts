// A Team's own Judge model (spec #225, slice 6a): `localModel` calls the Team's OpenAI-compatible URL through the
// pinned connection, with no key and no OpenRouter routing, falls back once to JSON mode when the JSON-schema request
// answers 400, and never follows a redirect. Against fake model servers on 127.0.0.1, with a stub resolver. Slice 7a:
// `openRouterModel` reads each answer's usage block for the spending ledger, and is the one paid model.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFakeModelServers,
  completion,
  fakeModelServer,
  json,
  resolvesTo,
} from "../../../test/fake-model-server.ts";
import { fakeOpenRouter, neverAnswers, verdict, withUsage } from "../../../test/fake-openrouter.ts";
import {
  judgeModel,
  localModel,
  ModelCallFailed,
  openRouterModel,
  type ChatMessage,
} from "./judge-model.ts";

afterEach(closeFakeModelServers);

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Judge the session." },
  { role: "user", content: "The events." },
];
const SCHEMA = { name: "judge_verdict", schema: { type: "object" } };

const model = (port: number, { allowLocalhost = true }: { allowLocalhost?: boolean } = {}) =>
  localModel({
    url: `http://localhost:${port}/v1`,
    model: "qwen3.8:27b",
    allowLocalhost,
    resolve: resolvesTo("127.0.0.1"),
    timeoutMs: 2_000,
  });

describe("localModel", () => {
  it("sends the Team's model name with the JSON-schema format, no Authorization header and no provider field", async () => {
    const server = await fakeModelServer(completion('{"broken_rules":[]}'));

    const answer = await model(server.port).complete(MESSAGES, SCHEMA);

    expect(answer).toEqual({ refusal: false, content: '{"broken_rules":[]}' });
    expect(server.received).toHaveLength(1);
    const [request] = server.received;
    expect(request!.headers).not.toHaveProperty("authorization");
    expect(request!.body).not.toHaveProperty("provider");
    expect(request!.body).toEqual({
      model: "qwen3.8:27b",
      messages: MESSAGES,
      response_format: {
        type: "json_schema",
        json_schema: { name: "judge_verdict", strict: true, schema: { type: "object" } },
      },
    });
  });

  it("asks once more in JSON mode with the same messages after a 400 to the JSON-schema request, and reads that answer", async () => {
    const server = await fakeModelServer(
      json(400, { error: "response_format json_schema unsupported" }),
      completion('{"broken_rules":[]}'),
    );

    const answer = await model(server.port).complete(MESSAGES, SCHEMA);

    expect(answer).toEqual({ refusal: false, content: '{"broken_rules":[]}' });
    expect(server.received.map((request) => request.body)).toEqual([
      expect.objectContaining({
        response_format: expect.objectContaining({ type: "json_schema" }),
      }),
      { model: "qwen3.8:27b", messages: MESSAGES, response_format: { type: "json_object" } },
    ]);
  });

  it("fails after a 400 to the JSON-mode request too, with no third request", async () => {
    const server = await fakeModelServer(json(400, {}), json(400, {}), completion("{}"));

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(ModelCallFailed);
    expect(server.received).toHaveLength(2);
  });

  it("doesn't fall back for an answer other than 400", async () => {
    const server = await fakeModelServer(json(500, {}), completion("{}"));

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(/500/);
    expect(server.received).toHaveLength(1);
  });

  it("fails on a 302 without following it: the server it points to gets no request", async () => {
    const target = await fakeModelServer(completion("{}"));
    const server = await fakeModelServer((res) => {
      res.writeHead(302, { Location: `http://localhost:${target.port}/v1/chat/completions` });
      res.end();
    });

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(
      new ModelCallFailed("the Judge's model call answered 302"),
    );
    expect(target.received).toEqual([]);
  });

  it("leaves the URL out of the error and its stack when the pinned connection refuses the address", async () => {
    const server = await fakeModelServer(completion("{}"));

    const error = (await model(server.port, { allowLocalhost: false })
      .complete(MESSAGES, SCHEMA)
      .catch((caught: unknown) => caught)) as Error;

    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(
      `localhost:${server.port}`,
    );
  });

  it("fails with ModelCallFailed naming the cap when the answer is over 1 MiB", async () => {
    const server = await fakeModelServer(completion("x".repeat(2 * 1024 * 1024)));

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(
      new ModelCallFailed("the Judge's model call failed: its answer is over 1 MiB"),
    );
  });

  it("throws ModelCallFailed without the URL when the connection fails", async () => {
    const server = await fakeModelServer();
    await server.close();

    const error = (await model(server.port)
      .complete(MESSAGES, SCHEMA)
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(ModelCallFailed);
    expect(error.message).not.toContain("localhost");
    expect(error.message).toMatch(/ECONNREFUSED/);
  });

  it("is free: its calls are never counted against the Team's spending", () => {
    expect(model(1)).toMatchObject({ model: "qwen3.8:27b", paid: false });
  });
});

describe("openRouterModel (story 10)", () => {
  const openRouter = (answer: Parameters<typeof fakeOpenRouter>[0]) =>
    openRouterModel({
      apiKey: "sk-or-v1-test",
      model: "test/judge-model",
      fetch: fakeOpenRouter(answer).fetch,
      timeoutMs: 50,
    });

  it("is paid, under the model name it sends", () => {
    expect(openRouter(() => verdict([]))).toMatchObject({ model: "test/judge-model", paid: true });
  });

  it("reads the answer's usage block: its tokens and its cost in dollars", async () => {
    const answer = await openRouter(() =>
      withUsage(verdict([]), { prompt_tokens: 1200, completion_tokens: 30, cost: 0.0042 }),
    ).complete(MESSAGES, SCHEMA);

    expect(answer).toEqual({
      refusal: false,
      content: '{"broken_rules":[]}',
      usage: { inputTokens: 1200, outputTokens: 30, costUsd: 0.0042 },
    });
  });

  it("leaves out each usage field that isn't a whole count or a cost at or above 0, and still reads the answer", async () => {
    const answer = await openRouter(() => ({
      ...verdict([]),
      usage: { prompt_tokens: -3, completion_tokens: "many", cost: null },
    })).complete(MESSAGES, SCHEMA);

    expect(answer).toEqual({ refusal: false, content: '{"broken_rules":[]}', usage: {} });
  });

  it("gives no usage for an answer without a usage block", async () => {
    const answer = await openRouter(() => verdict([])).complete(MESSAGES, SCHEMA);

    expect(answer).toEqual({ refusal: false, content: '{"broken_rules":[]}' });
  });

  it("throws ModelCallFailed for a call that times out, so the Judge retries it", async () => {
    await expect(openRouter(neverAnswers).complete(MESSAGES, SCHEMA)).rejects.toThrow(
      new ModelCallFailed("the Judge's model call timed out after 50 ms"),
    );
  });
});

describe("judgeModel without a key", () => {
  it("is paid, so a run is checked against the Team's limit before its ConfigError", () => {
    expect(judgeModel({ apiKey: undefined, model: "test/judge-model" })).toMatchObject({
      model: "test/judge-model",
      paid: true,
    });
  });
});
