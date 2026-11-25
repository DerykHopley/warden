// The Cloud Run starter, over a fake fetch: a token from the metadata server, then one jobs.run whose only override is
// the Scan's id and Team. Each failure rejects, naming the step and the status, and never the token.
import { describe, expect, it } from "vitest";
import { cloudRunScanJobStarter, type Fetch } from "./cloud-run-scan-job-starter.ts";

const JOB = "projects/p/locations/europe-west1/jobs/warden-scan";
const TOKEN = "ya29.the-access-token";
const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const RUN_URL = `https://run.googleapis.com/v2/${JOB}:run`;

type Call = { url: string; init: RequestInit };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TOKEN_ANSWER = () => json({ access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
const RUN_ANSWER = () => json({ name: "projects/p/locations/europe-west1/operations/op-1" });

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

async function rejection(started: Promise<void>): Promise<Error> {
  try {
    await started;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the start resolved");
}

const SCAN = { scanId: "scan-1", team: "org_a" };

describe("cloudRunScanJobStarter", () => {
  it("gets a token from the metadata server, then runs the Job with only the Scan's id and Team as overrides", async () => {
    const fake = fakeFetch();
    const start = cloudRunScanJobStarter({ job: JOB, fetch: fake.fetch });

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

  it("rejects when the token call answers 500, naming the step and the status", async () => {
    const fake = fakeFetch({ token: () => new Response("oops", { status: 500 }) });
    const start = cloudRunScanJobStarter({ job: JOB, fetch: fake.fetch });

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*500/);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects when the token answer has no access_token", async () => {
    const fake = fakeFetch({ token: () => json({ token_type: "Bearer" }) });
    const start = cloudRunScanJobStarter({ job: JOB, fetch: fake.fetch });

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/metadata server.*access_token/);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects when jobs.run answers 403, naming the step and the status, never the token", async () => {
    const fake = fakeFetch({
      run: () => json({ error: { code: 403, message: "Permission denied" } }, 403),
    });
    const start = cloudRunScanJobStarter({ job: JOB, fetch: fake.fetch });

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(/jobs\.run.*403/);
    expect(error.message).not.toContain(TOKEN);
  });

  it.each([
    ["the token call", { token: never }, /metadata server/],
    ["jobs.run", { run: never }, /jobs\.run/],
  ])("rejects when %s passes its timeout, never naming the token", async (_name, answers, step) => {
    const fake = fakeFetch(answers);
    const start = cloudRunScanJobStarter({ job: JOB, fetch: fake.fetch, timeoutMs: 20 });

    const error = await rejection(start(SCAN));

    expect(error.message).toMatch(step);
    expect(error.message).toMatch(/timed out/);
    expect(error.message).not.toContain(TOKEN);
  });
});
