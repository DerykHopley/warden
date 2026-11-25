// The GitHub reader over a fake fetch (spec decision 11: GitHub is faked at its HTTP boundary). For one repo it asks
// for an installation token scoped to that repo, contents read only, then that repo's default-branch tarball with it,
// and yields its files. The fake answers the tarball call with the archive itself, as fetch hands it back after
// following GitHub's redirect. Every failure throws GitHubInstallationUnreachable or GitHubUnavailable, and none
// carries the token, the App's JWT or the download URL.
import { createPublicKey, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { gitHubAppKey, rejection } from "../../../test/helpers.ts";
import { chunks, file, gitHubTarball, tar } from "../../../test/tarballs.ts";
import type { Fetch } from "../../http-call.ts";
import { createLogger } from "../../log.ts";
import { GitHubInstallationUnreachable, GitHubUnavailable } from "./github.ts";
import { createGitHubReader } from "./github-reader.ts";
import type { RepoFile, UnreadFile } from "./repo-reader.ts";

const PRIVATE_KEY = gitHubAppKey();
const CLIENT_ID = "Iv23li-the-client-id";
const INSTALLATION_TOKEN = "ghs_the-repo-scoped-installation-token";
const INSTALLATION_ID = 42;
const REPO = { ref: "https://github.com/example/guarded", githubId: 1234 };
/** Where GitHub's redirect sends the download, its own token in the query. */
const DOWNLOAD_URL =
  "https://codeload.github.com/example/guarded/legacy.tar.gz/refs/heads/main?token=the-download-token";

const ACCESS_TOKENS_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const TARBALL_URL = "https://api.github.com/repos/example/guarded/tarball";

const ARCHIVE = gitHubTarball([
  file("README.md", "# Guarded\n"),
  file("src/config.ts", "export const a = 1;\n"),
  file("logo.png", Buffer.from([0x89, 0x50, 0x00])),
]);
/** An archive of about 30 chunks: random bytes don't compress. */
const NOISY = gitHubTarball([
  file("README.md", "# Guarded\n"),
  file("noise.bin", randomBytes(15_000)),
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; init: RequestInit };
type Answer = (call: Call) => Promise<Response> | Response;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The call's download: `bytes` gzipped, streamed in 512-byte chunks `gapMs` apart, or stalling for good after
 * `stallAfter` chunks. As fetch's own body does, it errors with the call's signal's reason once that fires.
 */
function archive(
  { init }: Call,
  {
    bytes = ARCHIVE,
    gapMs = 0,
    stallAfter = Infinity,
  }: { bytes?: Uint8Array; gapMs?: number; stallAfter?: number } = {},
): Response {
  const signal = init.signal!;
  const source = chunks(bytes, 512);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    async pull(controller) {
      if (sent >= stallAfter) return new Promise<void>(() => {});
      await sleep(gapMs);
      const next = await source.next();
      if (signal.aborted) return;
      sent += 1;
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
  return new Response(body, { status: 200 });
}

/** An answer that never comes: it waits for the call's signal and rejects as fetch does when it fires. */
const never: Answer = ({ init }) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });

/** A download lost on the redirect's leg, as undici might name the URL it was fetching. */
const lostOnRedirect: Answer = () =>
  Promise.reject(
    new TypeError(`fetch failed: ${DOWNLOAD_URL}`, { cause: new Error(DOWNLOAD_URL) }),
  );

/** A fake GitHub: the token call and the tarball, each answered by its handler, every call recorded. */
function fakeGitHub({
  accessToken = () =>
    json(
      {
        token: INSTALLATION_TOKEN,
        expires_at: "2026-11-25T14:00:00Z",
        permissions: { contents: "read" },
        repository_selection: "selected",
      },
      201,
    ),
  tarball = (call) => archive(call),
  tarballUrl = TARBALL_URL,
  archiveTimeoutMs = 50,
}: {
  accessToken?: Answer;
  tarball?: Answer;
  /** Where the fake serves the tarball: the repo's own `/repos/<owner>/<repo>/tarball`. */
  tarballUrl?: string;
  archiveTimeoutMs?: number;
} = {}) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const routes: Record<string, Answer | undefined> = {
      [`POST ${ACCESS_TOKENS_URL}`]: accessToken,
      [`GET ${tarballUrl}`]: tarball,
    };
    const route = routes[`${init.method ?? "GET"} ${url}`];
    if (route === undefined) throw new Error(`unexpected call to ${init.method} ${url}`);
    return route(call);
  };
  const reader = createGitHubReader({
    clientId: CLIENT_ID,
    privateKey: PRIVATE_KEY,
    logger: createLogger((line) => lines.push(line)),
    fetch,
    timeoutMs: 50,
    archiveTimeoutMs,
  });
  return { reader, calls, lines };
}

async function readAll(
  reader: ReturnType<typeof createGitHubReader>,
  installationId = INSTALLATION_ID,
  repo = REPO,
): Promise<(RepoFile | UnreadFile)[]> {
  const files: (RepoFile | UnreadFile)[] = [];
  for await (const repoFile of reader.readRepo(installationId, repo)) files.push(repoFile);
  return files;
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

/** Everything an error carries: its name, message, stack, every own field, and its causes', unredacted. */
function everythingIn(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value !== "object") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  const names = new Set([
    ...Object.getOwnPropertyNames(value),
    ...(value instanceof Error ? ["name", "message", "stack", "cause"] : []),
  ]);
  return [...names]
    .map((name) => `${name}=${everythingIn((value as Record<string, unknown>)[name], seen)}`)
    .join("\n");
}

describe("createGitHubReader", () => {
  it("asks for a token for the one repo with contents read, then its tarball with that token, and yields its files", async () => {
    const { reader, calls } = fakeGitHub();
    const before = Math.floor(Date.now() / 1000);

    expect(await readAll(reader)).toEqual([
      { path: "README.md", text: "# Guarded\n" },
      { path: "src/config.ts", text: "export const a = 1;\n" },
      { path: "logo.png", unread: true },
    ]);

    const [tokenCall, tarballCall] = calls;
    expect(calls).toHaveLength(2);
    expect(tokenCall!.url).toBe(ACCESS_TOKENS_URL);
    expect(tokenCall!.init.method).toBe("POST");
    expect(JSON.parse(tokenCall!.init.body as string)).toEqual({
      repository_ids: [REPO.githubId],
      permissions: { contents: "read" },
    });
    const jwt = /^Bearer (.+)$/.exec(header(tokenCall!, "Authorization") ?? "")?.[1];
    const { payload } = await jwtVerify(jwt!, createPublicKey(PRIVATE_KEY), {
      algorithms: ["RS256"],
      issuer: CLIENT_ID,
    });
    expect(payload.iat).toBeLessThan(before);
    expect(payload.exp! - before).toBeLessThanOrEqual(600);

    expect(tarballCall!.url).toBe(TARBALL_URL);
    expect(tarballCall!.init.method ?? "GET").toBe("GET");
    expect(header(tarballCall!, "Authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    for (const { init } of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads a repo whose owner has an underscore, as an Enterprise Managed User's does", async () => {
    const tarballUrl = "https://api.github.com/repos/alice_acme/notes/tarball";
    const { reader, calls } = fakeGitHub({ tarballUrl });

    const read = await readAll(reader, INSTALLATION_ID, {
      ref: "https://github.com/alice_acme/notes",
      githubId: 1,
    });

    expect(read).toEqual([
      { path: "README.md", text: "# Guarded\n" },
      { path: "src/config.ts", text: "export const a = 1;\n" },
      { path: "logo.png", unread: true },
    ]);
    expect(calls.map(({ url }) => url)).toEqual([ACCESS_TOKENS_URL, tarballUrl]);
  });

  it("logs one line per repo with its ref and counts, and no path, text, token or URL", async () => {
    const { reader, lines } = fakeGitHub();

    await readAll(reader);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      severity: "INFO",
      message: "guard scan: archive read",
      repo: REPO.ref,
      files: 2,
      skipped: { notAFile: 1, tooLarge: 0, binary: 1, notUtf8: 0, badPath: 0 },
      compressedBytes: ARCHIVE.length,
      uncompressedBytes: expect.any(Number),
    });
    for (const secret of [INSTALLATION_TOKEN, "README.md", "# Guarded", TARBALL_URL, "codeload"]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  describe("ends the download, its signal fired, when the read stops before the archive's end", () => {
    it("because the scanner stopped after the first file", async () => {
      const { reader, calls } = fakeGitHub({
        tarball: (call) => archive(call, { bytes: NOISY }),
        archiveTimeoutMs: 60_000,
      });

      for await (const repoFile of reader.readRepo(INSTALLATION_ID, REPO)) {
        expect(repoFile.path).toBe("README.md");
        break;
      }

      expect(calls[1]!.init.signal!.aborted).toBe(true);
    });

    it("because the archive has a bad header", async () => {
      const bytes = tar([file("a.txt", "a\n"), file("noise.bin", randomBytes(15_000))]);
      bytes[0] = "b".charCodeAt(0);
      const { reader, calls } = fakeGitHub({
        tarball: (call) => archive(call, { bytes: gzipSync(bytes) }),
        archiveTimeoutMs: 60_000,
      });

      expect(await rejection(readAll(reader))).toBeInstanceOf(GitHubUnavailable);

      expect(calls[1]!.init.signal!.aborted).toBe(true);
    });
  });

  it("reads a download slower in all than its time limit, as long as no gap between chunks reaches it", async () => {
    const { reader } = fakeGitHub({
      tarball: (call) => archive(call, { bytes: NOISY, gapMs: 20 }),
      archiveTimeoutMs: 200,
    });

    expect((await readAll(reader)).map((repoFile) => repoFile.path)).toEqual([
      "README.md",
      "noise.bin",
    ]);
  });

  it.each([
    ["403", 403],
    ["404", 404],
    ["422, as for a repo the App no longer reaches", 422],
  ])(
    "throws GitHubInstallationUnreachable when the token call answers %s",
    async (_name, status) => {
      const { reader, calls } = fakeGitHub({
        accessToken: () => json({ message: "Not Found" }, status),
      });

      const error = await rejection(readAll(reader));

      expect(error).toBeInstanceOf(GitHubInstallationUnreachable);
      expect((error as GitHubInstallationUnreachable).status).toBe(status);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses installation id %s, which isn't a positive integer, before any call",
    async (installationId) => {
      const { reader, calls } = fakeGitHub();

      const error = await rejection(readAll(reader, installationId));

      expect(error).toBeInstanceOf(RangeError);
      expect(calls).toEqual([]);
    },
  );

  it.each([
    "http://github.com/example/guarded",
    "https://gitlab.com/example/guarded",
    "https://github.com/example",
    "https://github.com/example/guarded/tree/main",
    "https://github.com/example/guarded/",
    "https://github.com/example/..",
    "https://github.com/../guarded",
    "https://github.com/example/guarded?x=1",
    "https://github.com/example/guarded.git#x",
    "https://github.com/_/..",
    "https://github.com/a_b/c/d",
  ])("refuses the ref %s, which isn't a GitHub repo's URL, before any call", async (ref) => {
    const { reader, calls } = fakeGitHub();

    const error = await rejection(readAll(reader, INSTALLATION_ID, { ...REPO, ref }));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(calls).toEqual([]);
  });

  describe("fails with GitHubUnavailable, holding no token, JWT or download URL", () => {
    const tokenStep = `GitHub's installation token for installation ${INSTALLATION_ID}`;
    const tarballStep = `GitHub's tarball of ${REPO.ref}`;
    const cases: [string, Parameters<typeof fakeGitHub>[0], string, number | undefined][] = [
      ["a token call answering 500", { accessToken: () => json({}, 500) }, tokenStep, 500],
      ["a token call that never answers", { accessToken: never }, tokenStep, undefined],
      [
        "a token answer without a token",
        { accessToken: () => json({ expires_at: "x" }, 201) },
        tokenStep,
        201,
      ],
      [
        "a tarball 404, as an empty repo may answer",
        { tarball: () => json({}, 404) },
        tarballStep,
        404,
      ],
      ["a tarball 500", { tarball: () => json({}, 500) }, tarballStep, 500],
      ["a tarball that never answers", { tarball: never }, tarballStep, undefined],
      ["a download lost on the redirect", { tarball: lostOnRedirect }, tarballStep, undefined],
      [
        "a tarball cut short",
        { tarball: (call) => archive(call, { bytes: ARCHIVE.subarray(0, ARCHIVE.length - 30) }) },
        tarballStep,
        undefined,
      ],
      [
        "a download that stalls partway",
        { tarball: (call) => archive(call, { bytes: NOISY, stallAfter: 2 }) },
        tarballStep,
        undefined,
      ],
    ];

    it.each(cases)("with %s", async (_name, fakes, step, status) => {
      const { reader, calls, lines } = fakeGitHub(fakes);

      const error = await rejection(readAll(reader));

      expect(error).toBeInstanceOf(GitHubUnavailable);
      expect(error).toMatchObject({ step, status });
      const jwts = calls
        .map((call) => /^Bearer (eyJ.+)$/.exec(header(call, "Authorization") ?? "")?.[1])
        .filter((jwt) => jwt !== undefined);
      const logged: string[] = [];
      createLogger((line) => logged.push(line)).error("scan failed", { error });
      for (const serialised of [everythingIn(error), logged.join(""), lines.join("")]) {
        for (const secret of [INSTALLATION_TOKEN, DOWNLOAD_URL, "the-download-token", ...jwts]) {
          expect(serialised).not.toContain(secret);
        }
      }
    });

    it("names the timeout", async () => {
      const { reader } = fakeGitHub({ tarball: never });

      const error = await rejection(readAll(reader));

      expect(error.message).toMatch(/timed out after 50 ms/);
    });
  });
});
