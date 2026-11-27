// A fake model server for the tests of a Team's own Judge model (spec #225, slice 6a): an HTTP server on 127.0.0.1
// that answers each request in turn, keeps every request and counts its connections, and a stub resolver, so no case
// reaches DNS. A test file closes its servers with `afterEach(closeFakeModelServers)`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Resolve } from "../src/modules/guard/judge-url.ts";

/** One request the server got: its body as text, and parsed as JSON (`{}` when it's empty or isn't JSON). */
export type Received = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  text: string;
  body: Record<string, unknown>;
};

/** How the server answers one request. */
export type Answer = (res: ServerResponse, req: IncomingMessage) => void;

/** Answers `status` with `body` as JSON. */
export const json =
  (status: number, body: unknown): Answer =>
  (res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

/** Answers 200 with a chat completion whose one message holds `content`. */
export const completion = (content: string): Answer =>
  json(200, { choices: [{ message: { role: "assistant", content } }] });

const open: Server[] = [];

/** Closes every server the case started, with its connections. */
export async function closeFakeModelServers(): Promise<void> {
  await Promise.all(open.splice(0).map(close));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function parse(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A server on 127.0.0.1 whose `answers` reply to its requests in turn, the last one to every request after it; with
 * none, each request is answered 200 with `{ "answered": true }`. `close` stops it before the case ends.
 */
export async function fakeModelServer(...answers: Answer[]) {
  const received: Received[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (text += chunk));
    req.on("end", () => {
      received.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        text,
        body: parse(text),
      });
      const answer =
        answers.length > 1 ? answers.shift()! : (answers[0] ?? json(200, { answered: true }));
      answer(res, req);
    });
  });
  server.on("connection", () => (connections += 1));
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    connections: () => connections,
    close: () => {
      open.splice(open.indexOf(server), 1);
      return close(server);
    },
  };
}

/** A resolver answering `addresses` for every host, as `dns.promises.lookup` with `{ all: true }` does; `asked` keeps
 * each host it was asked for. */
export function resolvesTo(...addresses: string[]): Resolve & { asked: string[] } {
  const asked: string[] = [];
  const resolve: Resolve = (host) => {
    asked.push(host);
    return Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };
  return Object.assign(resolve, { asked });
}
