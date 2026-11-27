// The pinned connection for a Team's own Judge model (spec #225, slice 6a): `pinnedFetch` resolves the host through
// its resolver, refuses an address the URL rule refuses before any connection opens, and otherwise connects to the
// address it checked. Against a test HTTP server on 127.0.0.1 that counts its connections; the resolver is a stub, so
// no case reaches DNS.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AddressRefused, type Resolve } from "./judge-url.ts";
import { pinnedFetch } from "./pinned-fetch.ts";

type Received = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

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

/** A test server on 127.0.0.1 answering with `answer`, counting its connections and keeping each request. */
async function testServer(
  answer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answered: true }));
  },
) {
  const received: Received[] = [];
  const state = { connections: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      answer(req, res);
    });
  });
  server.on("connection", () => (state.connections += 1));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as AddressInfo).port, received, state };
}

/** A resolver answering 127.0.0.1 for every host, keeping each host it was asked for. */
function loopbackResolver() {
  const asked: string[] = [];
  const resolve: Resolve = (host) => {
    asked.push(host);
    return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
  };
  return { resolve, asked };
}

describe("pinnedFetch", () => {
  it("refuses a host resolving to loopback with allowLocalhost off, naming the reason, and opens no connection", async () => {
    const server = await testServer();
    const { resolve, asked } = loopbackResolver();
    const fetch = pinnedFetch({ allowLocalhost: false, resolve });

    const call = fetch(`http://judge.test:${server.port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });

    await expect(call).rejects.toThrow(AddressRefused);
    await expect(call).rejects.toThrow(/loopback/);
    expect(asked).toEqual(["judge.test"]);
    expect(server.state.connections).toBe(0);
    expect(server.received).toEqual([]);
  });

  it("refuses an address in the URL itself with allowLocalhost off, and opens no connection", async () => {
    const server = await testServer();
    const { resolve } = loopbackResolver();

    await expect(
      pinnedFetch({ allowLocalhost: false, resolve })(`http://127.0.0.1:${server.port}/v1`, {
        method: "GET",
      }),
    ).rejects.toThrow(AddressRefused);
    expect(server.state.connections).toBe(0);
  });

  it("refuses localhost resolving to an address that isn't loopback, with allowLocalhost on", async () => {
    const server = await testServer();
    const resolve: Resolve = () =>
      Promise.resolve([
        { address: "127.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]);

    await expect(
      pinnedFetch({ allowLocalhost: true, resolve })(`http://localhost:${server.port}/v1`, {
        method: "GET",
      }),
    ).rejects.toThrow(/link-local/);
    expect(server.state.connections).toBe(0);
  });

  it("reaches localhost with allowLocalhost on, through the resolver's address, with the request's method, headers and body", async () => {
    const server = await testServer();
    const { resolve, asked } = loopbackResolver();

    const response = await pinnedFetch({ allowLocalhost: true, resolve })(
      `http://localhost:${server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answered: true });
    expect(asked).toEqual(["localhost"]);
    expect(server.state.connections).toBe(1);
    expect(server.received).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/v1/chat/completions",
        headers: expect.objectContaining({ "content-type": "application/json" }),
        body: JSON.stringify({ model: "m" }),
      }),
    ]);
  });

  it("answers a 3xx as it is, without following it", async () => {
    const target = await testServer();
    const server = await testServer((_req, res) => {
      res.writeHead(302, { Location: `http://localhost:${target.port}/v1` });
      res.end();
    });
    const { resolve } = loopbackResolver();

    const response = await pinnedFetch({ allowLocalhost: true, resolve })(
      `http://localhost:${server.port}/v1`,
      { method: "GET" },
    );

    expect(response.status).toBe(302);
    expect(target.state.connections).toBe(0);
  });

  it("stops the call when its signal fires", async () => {
    const server = await testServer(() => {
      // Never answers.
    });
    const { resolve } = loopbackResolver();

    await expect(
      pinnedFetch({ allowLocalhost: true, resolve })(`http://localhost:${server.port}/v1`, {
        method: "GET",
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
  });
});
