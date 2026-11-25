// The Cloud Run starter, over a fake fetch: a token from the metadata server, then one jobs.run whose only override is
// the Scan's id and Team. Each failure rejects, naming the step and the status, and never the token. A jobs.run that
// times out or never answers rejects as unknown: Google may have started the execution.
import { describe, expect, it } from "vitest";
import { cloudRunScanJobStarter, type Fetch } from "./cloud-run-scan-job-starter.ts";
import { createLogger } from "./log.ts";
import { ScanJobStartUnknown } from "./scans.ts";

const JOB = "projects/p/locations/europe-west1/jobs/warden-scan";
const TOKEN = "ya29.the-access-token";
const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const RUN_URL = `https://run.googleapis.com/v2/${JOB}:run`;
const OPERATION = "projects/p/locations/europe-west1/operations/op-1";

type Call = { url: string; init: RequestInit };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TOKEN_ANSWER = () => json({ access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
const RUN_ANSWER = () => json({ name: OPERATION });

/** A fetch that answers the token call with `token` and jobs.run with `run`, recording each call. */
function fakeFetch({
  token = TOKEN_ANSWER,
  run = RUN_ANSWER,
}: {
  token?: (init: RequestInit) => Promise<Response> | Response;
  run?: (init: RequestInit) => Promise<Response> | Response;
} = {}) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) return token(init);
    if (url === RUN_URL) return run(init);
    throw new Error(`unexpected call to ${url}`);
  };
  return { calls, fetch };
}

/** An answer that never comes: it waits for the call's signal and rejects as fetch does when it fires. */
const never = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });

/** A connection that drops before any answer, as undici's fetch rejects. */
const dropped = () => Promise.reject(new TypeError("fetch failed"));

/** A 200 whose body never arrives: it errors as fetch's body does when the call's signal fires. */
const bodyNever = (init: RequestInit) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    }),
    { status: 200 },
  );

async function rejection(started: Promise<void>): Promise<Error> {
  try {
    await started;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the start resolved");
}

const SCAN = { scanId: "scan-1", team: "org_a" };

/** The starter over `fake`, with its log lines. */
function starter(fake: { fetch: Fetch }, timeoutMs?: number) {
  const lines: string[] = [];
  const start = cloudRunScanJobStarter({
    job: JOB,
    fetch: fake.fetch,
    logger: createLogger((line) => lines.push(line)),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { start, entries };
}

describe("cloudRunScanJobStarter", () => {
  it("gets a token from the metadata server, then runs the Job with only the Scan's id and Team as overrides", async () => {
    const fake = fakeFetch();
    const { start } = starter(fake);

    await start(SCAN);

    expect(fake.calls.map(({ url, init }) => [url, init.method ?? "GET"])).toEqual([
      [TOKEN_URL, "GET"],
      [RUN_URL, "POST"],
    ]);
    const [tokenCall, runCall] = fake.calls;
    expect(new Headers(tokenCall!.init.headers).get("Metadata-Flavor")).toBe("Google");
    expect(new Headers(runCall!.init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(runCall!.init.body as string)).toEqual({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "WARDEN_SCAN_ID", value: "scan-1" },
              { name: "WARDEN_TEAM", value: "org_a" },
            ],
          },
        ],
      },
    });
    for (const { init } of fake.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs the operation jobs.run answered with the Scan's id and Team", async () => {
    const { start, entries } = starter(fakeFetch());

    await start(SCAN);

    expect(entries()).toContainEqual(
      expect.objectContaining({ severity: "INFO", operation: OPERATION, ...SCAN }),
    );
  });

  it("still resolves when jobs.run's 2xx body never arrives: the Job started", async () => {
    const { start, entries } = starter(fakeFetch({ run: bodyNever }), 20);

    await start(SCAN);

    expect(entries()).toContainEqual(expect.objectContaining({ severity: "WARNING", ...SCAN }));
  });

  it("rejects when the token call answers 500, naming the step and the status", async () => {
    const fake = fakeFetch({ token: () => new Response("oops", { status: 500 }) });
    const { start } = starter(fake);

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*500/);
    expect(error).not.toBeInstanceOf(ScanJobStartUnknown);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    ["has no access_token", () => json({ token_type: "Bearer" })],
    ["isn't JSON", () => new Response("<html>", { status: 200 })],
  ])("rejects when the token answer %s", async (_name, token) => {
    const fake = fakeFetch({ token });
    const { start } = starter(fake);

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*access_token/);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects as timed out, not as a missing access_token, when the token answer's body never arrives", async () => {
    const fake = fakeFetch({ token: bodyNever });
    const { start } = starter(fake, 20);

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*timed out/);
    expect(error.message).not.toMatch(/access_token/);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    [
      403,
      "PERMISSION_DENIED",
      "Permission 'run.jobs.runWithOverrides' denied on resource 'warden-scan'",
    ],
    [404, "NOT_FOUND", "Resource 'warden-scan' of kind 'JOB' does not exist."],
  ])(
    "rejects when jobs.run answers %i, naming the step, the status and Google's reason, never the token",
    async (code, status, message) => {
      const fake = fakeFetch({ run: () => json({ error: { code, status, message } }, code) });
      const { start } = starter(fake);

      const error = await rejection(start(SCAN));

      expect(error.message).toMatch(new RegExp(`jobs\\.run.*${code}`));
      expect(error.message).toContain(status);
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(TOKEN);
      expect(error).not.toBeInstanceOf(ScanJobStartUnknown);
    },
  );

  it("rejects with the status alone when jobs.run's refusal isn't Google's JSON", async () => {
    const fake = fakeFetch({ run: () => new Response("Bad Gateway", { status: 502 }) });
    const { start } = starter(fake);

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/jobs\.run.*502/);
    expect(error).not.toBeInstanceOf(ScanJobStartUnknown);
  });

  it("rejects, as a failed start, when the token call passes its timeout, never naming the token", async () => {
    const { start } = starter(fakeFetch({ token: never }), 20);

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*timed out/);
    expect(error).not.toBeInstanceOf(ScanJobStartUnknown);
  });

  it.each([
    ["passes its timeout", never, /timed out/],
    ["loses its connection", dropped, /fetch failed/],
  ])(
    "rejects as unknown when jobs.run %s: the Job may have started",
    async (_name, run, reason) => {
      const { start } = starter(fakeFetch({ run }), 20);

      const error = await rejection(start(SCAN));

      expect(error).toBeInstanceOf(ScanJobStartUnknown);
      expect(error.message).toMatch(/jobs\.run/);
      expect(error.message).toMatch(reason);
      expect(error.message).not.toContain(TOKEN);
    },
  );
});
