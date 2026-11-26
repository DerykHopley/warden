// The npm and PyPI latest-version lookup (spec #224, story 6) over a fake fetch: each registry is faked at its HTTP
// boundary, so no test reaches npm or PyPI. A name that could change the URL's path is refused before any call, and
// no version a registry sends gets past the scanner's pinned-version shape.
import { describe, expect, it } from "vitest";
import type { Fetch } from "../../http-call.ts";
import {
  createPackageRegistry,
  RegistryUnavailable,
  UnpinnableVersion,
} from "./package-registry.ts";

type Answer = (init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A registry over a fake fetch that gives `answer` to every call, recording each URL. */
function fakeRegistry(answer: Answer, timeoutMs = 1000) {
  const urls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    urls.push(url);
    return answer(init);
  };
  return { registry: createPackageRegistry({ fetch, timeoutMs }), urls };
}

/** An answer that never comes: it waits for the call's signal and rejects as fetch does when it fires. */
const never: Answer = (init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });

describe("createPackageRegistry", () => {
  it("reads npm's latest for a plain name", async () => {
    const { registry, urls } = fakeRegistry(() => json({ name: "some-pkg", version: "1.2.3" }));
    await expect(registry.latestVersion("npm", "some-pkg")).resolves.toBe("1.2.3");
    expect(urls).toEqual(["https://registry.npmjs.org/some-pkg/latest"]);
  });

  it("reads npm's latest for a scoped name, with the scope's / encoded", async () => {
    const { registry, urls } = fakeRegistry(() => json({ version: "2.0.0-beta.1" }));
    await expect(registry.latestVersion("npm", "@scope/pkg")).resolves.toBe("2.0.0-beta.1");
    expect(urls).toEqual(["https://registry.npmjs.org/@scope%2Fpkg/latest"]);
  });

  it("reads PyPI's info.version", async () => {
    const { registry, urls } = fakeRegistry(() =>
      json({ info: { name: "mcp-server-fetch", version: "2025.4.7" }, releases: {} }),
    );
    await expect(registry.latestVersion("pypi", "mcp-server-fetch")).resolves.toBe("2025.4.7");
    expect(urls).toEqual(["https://pypi.org/pypi/mcp-server-fetch/json"]);
  });

  it.each(["npm", "pypi"] as const)("answers undefined for a 404 from %s", async (registryName) => {
    const { registry } = fakeRegistry(() => json({ message: "Not Found" }, 404));
    await expect(registry.latestVersion(registryName, "missing-pkg")).resolves.toBeUndefined();
  });

  it.each([
    ["an epoch", "1!2.0"],
    ["a local version", "1.0+ubuntu.1"],
    ["a dash post-release", "1.0-1"],
    ["a spelled-out pre-release", "1.0alpha1"],
  ])(
    "throws UnpinnableVersion for a valid PEP 440 version outside the pinned shape: %s",
    async (_case, version) => {
      const { registry } = fakeRegistry(() => json({ info: { version } }));
      const call = registry.latestVersion("pypi", "some-pkg");
      await expect(call).rejects.toBeInstanceOf(UnpinnableVersion);
      await expect(call).rejects.toMatchObject({ registry: "pypi" });
    },
  );

  it.each([
    ["a 500", () => json({ message: "Server Error" }, 500)],
    ["a connection lost", () => Promise.reject(new TypeError("fetch failed"))],
    ["a body that isn't JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["an answer with no version", () => json({ name: "some-pkg" })],
    ["a version like 1.0; rm -rf /", () => json({ version: "1.0; rm -rf /" })],
    ["a tag rather than a version", () => json({ version: "latest" })],
  ] as const)("throws RegistryUnavailable from npm for %s", async (_case, answer) => {
    const { registry } = fakeRegistry(answer);
    const call = registry.latestVersion("npm", "some-pkg");
    await expect(call).rejects.toBeInstanceOf(RegistryUnavailable);
    await expect(call).rejects.toMatchObject({ registry: "npm" });
  });

  it("throws RegistryUnavailable from PyPI for a version like 1.0; rm -rf /", async () => {
    const { registry } = fakeRegistry(() => json({ info: { version: "1.0; rm -rf /" } }));
    await expect(registry.latestVersion("pypi", "some-pkg")).rejects.toMatchObject({
      name: "RegistryUnavailable",
      registry: "pypi",
    });
  });

  it("names the registry and the status only", async () => {
    const { registry } = fakeRegistry(() => json({ secret: "do-not-echo" }, 503));
    const error = await registry.latestVersion("npm", "some-pkg").catch((e: unknown) => e);
    expect(error).toMatchObject({ registry: "npm", status: 503 });
    expect(String((error as Error).message)).not.toContain("do-not-echo");
    expect(String((error as Error).message)).not.toContain("some-pkg");
  });

  it("throws RegistryUnavailable for a timeout", async () => {
    const { registry } = fakeRegistry(never, 10);
    await expect(registry.latestVersion("pypi", "some-pkg")).rejects.toMatchObject({
      name: "RegistryUnavailable",
      registry: "pypi",
      status: undefined,
    });
  });

  it.each([
    ["npm", "pkg/.."],
    ["npm", "@scope/pkg/.."],
    ["npm", "pkg?x=1"],
    ["npm", "some pkg"],
    ["npm", ""],
    ["pypi", "pkg/.."],
    ["pypi", "pkg?x=1"],
    ["pypi", "some pkg"],
    ["pypi", "pkg[extra]"],
  ] as const)(
    "refuses %s name %j with a RangeError before any call",
    async (registryName, name) => {
      const { registry, urls } = fakeRegistry(() => json({ version: "1.0.0" }));
      await expect(registry.latestVersion(registryName, name)).rejects.toBeInstanceOf(RangeError);
      expect(urls).toHaveLength(0);
    },
  );
});
