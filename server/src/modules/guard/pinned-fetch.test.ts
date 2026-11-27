// The pinned connection for a Team's own Judge model (spec #225, slice 6a): `pinnedFetch` checks the URL's scheme,
// resolves the host through its resolver, refuses an address the URL rule refuses before any connection opens, and
// otherwise connects to the address it checked; it reads an answer only up to its cap. Against a fake model server on
// 127.0.0.1 that counts its connections; the resolver is a stub, so no case reaches DNS.
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFakeModelServers,
  fakeModelServer,
  resolvesTo,
} from "../../../test/fake-model-server.ts";
import { AddressRefused } from "./judge-url.ts";
import { pinnedFetch } from "./pinned-fetch.ts";

afterEach(closeFakeModelServers);

describe("pinnedFetch", () => {
  it("refuses a host resolving to loopback with allowLocalhost off, naming the reason, and opens no connection", async () => {
    const server = await fakeModelServer();
    const resolve = resolvesTo("127.0.0.1");
    const fetch = pinnedFetch({ allowLocalhost: false, resolve });

    const call = fetch(`https://judge.test:${server.port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });

    await expect(call).rejects.toThrow(AddressRefused);
    await expect(call).rejects.toThrow(/loopback/);
    expect(resolve.asked).toEqual(["judge.test"]);
    expect(server.connections()).toBe(0);
    expect(server.received).toEqual([]);
  });

  it("refuses an address in the URL itself with allowLocalhost off, and opens no connection", async () => {
    const server = await fakeModelServer();

    await expect(
      pinnedFetch({ allowLocalhost: false, resolve: resolvesTo("127.0.0.1") })(
        `https://127.0.0.1:${server.port}/v1`,
        { method: "GET" },
      ),
    ).rejects.toThrow(AddressRefused);
    expect(server.connections()).toBe(0);
  });

  it.each([
    ["a host that isn't local", "http://judge.test/v1", true],
    ["localhost with allowLocalhost off", "http://localhost/v1", false],
  ])("refuses http to %s before it looks the host up", async (_name, url, allowLocalhost) => {
    const resolve = resolvesTo();

    await expect(pinnedFetch({ allowLocalhost, resolve })(url, { method: "GET" })).rejects.toThrow(
      /scheme isn't https/,
    );
    expect(resolve.asked).toEqual([]);
  });

  it("reaches localhost with allowLocalhost on, through the resolver's address, with the request's method, headers and body", async () => {
    const server = await fakeModelServer();
    const resolve = resolvesTo("127.0.0.1");

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
    expect(resolve.asked).toEqual(["localhost"]);
    expect(server.connections()).toBe(1);
    expect(server.received).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/v1/chat/completions",
        headers: expect.objectContaining({ "content-type": "application/json" }),
        text: JSON.stringify({ model: "m" }),
      }),
    ]);
  });

  it("answers a 3xx as it is, without following it", async () => {
    const target = await fakeModelServer();
    const server = await fakeModelServer((res) => {
      res.writeHead(302, { Location: `http://localhost:${target.port}/v1` });
      res.end();
    });

    const response = await pinnedFetch({ allowLocalhost: true, resolve: resolvesTo("127.0.0.1") })(
      `http://localhost:${server.port}/v1`,
      { method: "GET" },
    );

    expect(response.status).toBe(302);
    expect(target.connections()).toBe(0);
  });

  it("fails the answer's read once it passes 1 MiB, and closes the connection", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
    const server = await fakeModelServer((res) => {
      res.on("close", closed);
      res.writeHead(200, { "Content-Type": "application/json" });
      endless(res);
    });

    const read = pinnedFetch({ allowLocalhost: true, resolve: resolvesTo("127.0.0.1") })(
      `http://localhost:${server.port}/v1`,
      { method: "GET", signal: AbortSignal.timeout(2_000) },
    ).then((response) => response.text());

    await expect(read).rejects.toThrow(/over 1 MiB/);
    await connectionClosed;
  });

  it("stops the call when its signal fires", async () => {
    const server = await fakeModelServer(() => {
      // Never answers.
    });

    await expect(
      pinnedFetch({ allowLocalhost: true, resolve: resolvesTo("127.0.0.1") })(
        `http://localhost:${server.port}/v1`,
        { method: "GET", signal: AbortSignal.timeout(50) },
      ),
    ).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
  });
});

/** Writes spaces to `res` until its connection closes. */
function endless(res: ServerResponse) {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const more = () => {
    while (!res.destroyed && res.write(chunk));
    if (!res.destroyed) res.once("drain", more);
  };
  more();
}
