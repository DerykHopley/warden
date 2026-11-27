// A Team's own Judge model (spec #225, slice 6a): `localModel` calls the Team's OpenAI-compatible URL through the
// pinned connection, with no key and no OpenRouter routing, falls back once to JSON mode when the JSON-schema request
// answers 400, and never follows a redirect. Against test servers on 127.0.0.1, with a stub resolver.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { localModel, ModelCallFailed, type ChatMessage } from "./judge-model.ts";
import type { Resolve } from "./judge-url.ts";

type Received = { headers: IncomingMessage["headers"]; body: Record<string, unknown> };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A test server on 127.0.0.1 whose `answers` reply to its requests in turn; it keeps each request. */
async function testServer(...answers: ((res: ServerResponse) => void)[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      received.push({
        headers: req.headers,
        body: body === "" ? {} : (JSON.parse(body) as Record<string, unknown>),
      });
      const answer = answers.shift();
      if (answer) answer(res);
      else res.writeHead(500).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as AddressInfo).port, received };
}

const json = (status: number, body: unknown) => (res: ServerResponse) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const completion = (content: string) =>
  json(200, { choices: [{ message: { role: "assistant", content } }] });

const loopback: Resolve = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Judge the session." },
  { role: "user", content: "The events." },
];
const SCHEMA = { name: "judge_verdict", schema: { type: "object" } };

const model = (port: number, options: { allowLocalhost?: boolean; resolve?: Resolve } = {}) =>
  localModel({
    url: `http://localhost:${port}/v1`,
    model: "qwen3.8:27b",
    allowLocalhost: options.allowLocalhost ?? true,
    resolve: options.resolve ?? loopback,
    timeoutMs: 2_000,
  });

describe("localModel", () => {
  it("sends the Team's model name with the JSON-schema format, no Authorization header and no provider field", async () => {
    const server = await testServer(completion('{"broken_rules":[]}'));

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
    const server = await testServer(
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
    const server = await testServer(json(400, {}), json(400, {}), completion("{}"));

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(ModelCallFailed);
    expect(server.received).toHaveLength(2);
  });

  it("doesn't fall back for an answer other than 400", async () => {
    const server = await testServer(json(500, {}), completion("{}"));

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(/500/);
    expect(server.received).toHaveLength(1);
  });

  it("fails on a 302 without following it: the server it points to gets no request", async () => {
    const target = await testServer(completion("{}"));
    const server = await testServer((res) => {
      res.writeHead(302, { Location: `http://localhost:${target.port}/v1/chat/completions` });
      res.end();
    });

    await expect(model(server.port).complete(MESSAGES, SCHEMA)).rejects.toThrow(
      new ModelCallFailed("the Judge's model call answered 302"),
    );
    expect(target.received).toEqual([]);
  });

  it("throws ModelCallFailed naming the reason, never the URL, when the pinned connection refuses the address", async () => {
    const server = await testServer(completion("{}"));

    const call = model(server.port, { allowLocalhost: false }).complete(MESSAGES, SCHEMA);

    await expect(call).rejects.toThrow(ModelCallFailed);
    const error = (await call.catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/loopback/);
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(
      `localhost:${server.port}`,
    );
    expect(server.received).toEqual([]);
  });

  it("throws ModelCallFailed without the URL when the connection fails", async () => {
    const server = await testServer();
    const closed = servers.pop()!;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = (await model(server.port)
      .complete(MESSAGES, SCHEMA)
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(ModelCallFailed);
    expect(error.message).not.toContain("localhost");
    expect(error.message).toMatch(/ECONNREFUSED/);
  });
});
