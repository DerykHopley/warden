// The URL rule for a Team's own Judge model (spec #225, slice 6a; owner, 2026-11-27, Q5): which addresses count as
// public, and which URLs an Admin may set, over a stub resolver so no case reaches DNS.
import { describe, expect, it } from "vitest";
import { checkJudgeUrl, isPublicAddress, type Resolve } from "./judge-url.ts";

describe("isPublicAddress", () => {
  it.each(["93.184.215.14", "2606:4700::1"])("is true for %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["shared 100.64/10", "100.64.0.1"],
    ["link-local, the metadata server", "169.254.169.254"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique local", "fc00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])("is false for %s (%s)", (_name, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    ["IPv4-mapped metadata server, in hex", "::ffff:a9fe:a9fe"],
    ["the IPv6 unspecified address", "::"],
    ["IPv6 multicast", "ff02::1"],
    ["a name, not an address", "models.example.com"],
  ])("is false for %s (%s)", (_name, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

/** A resolver answering `addresses` for every host, as `dns.promises.lookup` with `{ all: true }` does. */
const answering =
  (...addresses: string[]): Resolve =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );

const PUBLIC = answering("93.184.215.14");

describe("checkJudgeUrl", () => {
  it("accepts an https URL whose host resolves to a public address", async () => {
    expect(
      await checkJudgeUrl("https://models.example.com/v1", {
        allowLocalhost: false,
        resolve: PUBLIC,
      }),
    ).toEqual({ ok: true, url: "https://models.example.com/v1" });
  });

  it.each<[string, string, Resolve, RegExp]>([
    ["http", "http://models.example.com/v1", PUBLIC, /https/],
    ["a user name", "https://admin@models.example.com/v1", PUBLIC, /user name or password/],
    ["a query", "https://models.example.com/v1?key=abc", PUBLIC, /query/],
    ["a fragment", "https://models.example.com/v1#top", PUBLIC, /fragment/],
    [
      "over 2048 characters",
      `https://models.example.com/${"a".repeat(2048)}`,
      PUBLIC,
      /2048 characters/,
    ],
    [
      "a host that doesn't resolve",
      "https://models.example.com/v1",
      () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
      /doesn't resolve/,
    ],
    [
      "a host that resolves to nothing",
      "https://models.example.com/v1",
      answering(),
      /doesn't resolve/,
    ],
    [
      "a host that resolves to a public address and 10.0.0.5",
      "https://models.example.com/v1",
      answering("93.184.215.14", "10.0.0.5"),
      /private/,
    ],
    ["something that isn't a URL", "models.example.com/v1", PUBLIC, /isn't a URL/],
  ])("refuses a URL with %s, with a reason", async (_name, url, resolve, reason) => {
    const checked = await checkJudgeUrl(url, { allowLocalhost: false, resolve });
    expect(checked).toEqual({ ok: false, reason: expect.stringMatching(reason) });
  });

  it("never names the URL in its reason", async () => {
    const url = "https://models.example.com/secret-path-token?key=abc";
    const checked = await checkJudgeUrl(url, { allowLocalhost: false, resolve: PUBLIC });
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).not.toContain("secret-path-token");
    expect(JSON.stringify(checked)).not.toContain("models.example.com");
  });

  describe("localhost", () => {
    const LOOPBACK = answering("127.0.0.1", "::1");

    it("refuses http://localhost:11434/v1 with allowLocalhost off", async () => {
      expect(
        await checkJudgeUrl("http://localhost:11434/v1", {
          allowLocalhost: false,
          resolve: LOOPBACK,
        }),
      ).toEqual({ ok: false, reason: expect.stringMatching(/https/) });
    });

    it("refuses https://localhost:11434/v1 with allowLocalhost off, for its address", async () => {
      expect(
        await checkJudgeUrl("https://localhost:11434/v1", {
          allowLocalhost: false,
          resolve: LOOPBACK,
        }),
      ).toEqual({ ok: false, reason: expect.stringMatching(/loopback/) });
    });

    it.each([
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1",
      "http://[::1]:11434/v1",
      "https://localhost/v1",
    ])("accepts %s with allowLocalhost on", async (url) => {
      expect(await checkJudgeUrl(url, { allowLocalhost: true, resolve: LOOPBACK })).toEqual({
        ok: true,
        url,
      });
    });

    it("still refuses http://10.0.0.5:11434/v1 with allowLocalhost on", async () => {
      expect(
        await checkJudgeUrl("http://10.0.0.5:11434/v1", {
          allowLocalhost: true,
          resolve: answering("10.0.0.5"),
        }),
      ).toEqual({ ok: false, reason: expect.any(String) });
    });

    it("refuses localhost resolving to an address that isn't loopback, with allowLocalhost on", async () => {
      expect(
        await checkJudgeUrl("http://localhost:11434/v1", {
          allowLocalhost: true,
          resolve: answering("127.0.0.1", "169.254.169.254"),
        }),
      ).toEqual({ ok: false, reason: expect.stringMatching(/link-local/) });
    });

    it("refuses another name resolving to loopback, with allowLocalhost on", async () => {
      expect(
        await checkJudgeUrl("https://judge.test/v1", {
          allowLocalhost: true,
          resolve: answering("127.0.0.1"),
        }),
      ).toEqual({ ok: false, reason: expect.stringMatching(/loopback/) });
    });
  });
});
