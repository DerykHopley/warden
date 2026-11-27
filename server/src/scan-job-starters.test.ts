// Which Scan Job starter, and which Judge run starter, the server wires: the Cloud Run Job whenever one is named, the
// child process off Cloud Run otherwise, and none on Cloud Run without a Job (a start there answers 503). Each starter
// is told apart by what it calls: fetch for the Cloud Run Job, spawn for the child process.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Fetch } from "./http-call.ts";
import type { Spawn } from "./local-scan-job-starter.ts";
import { createLogger } from "./log.ts";
import {
  dailyJudgeJobStarterFor,
  judgeJobStarterFor,
  scanJobStarterFor,
} from "./scan-job-starters.ts";

const JOB = "projects/p/locations/europe-west1/jobs/warden-scan";

function fakes() {
  const fetched: string[] = [];
  const spawned: string[][] = [];
  const fetch: Fetch = async (url) => {
    fetched.push(url);
    return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
  };
  const spawn: Spawn = (_command, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    // Started, then exited at once, so a starter that waits for the exit resolves too.
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("exit", 0, null);
    });
    return child;
  };
  return { fetched, spawned, deps: { logger: createLogger(() => {}), fetch, spawn } };
}

const SCAN = { scanId: "scan-1", team: "org_a" };

describe("scanJobStarterFor", () => {
  it.each([
    ["on Cloud Run", true],
    ["off Cloud Run", false],
  ])("runs the Cloud Run Job when one is named, %s", async (_name, behindCloudRun) => {
    const fake = fakes();
    const start = scanJobStarterFor({ scanJob: JOB, behindCloudRun }, fake.deps);

    await start!(SCAN);

    expect(fake.fetched).toContain(`https://run.googleapis.com/v2/${JOB}:run`);
    expect(fake.spawned).toEqual([]);
  });

  it("runs the Job as a child process off Cloud Run when no Job is named", async () => {
    const fake = fakes();
    const start = scanJobStarterFor({ scanJob: undefined, behindCloudRun: false }, fake.deps);

    await start!(SCAN);

    expect(fake.spawned).toHaveLength(1);
    expect(fake.fetched).toEqual([]);
  });

  it("wires none on Cloud Run when no Job is named", () => {
    const fake = fakes();
    expect(scanJobStarterFor({ scanJob: undefined, behindCloudRun: true }, fake.deps)).toBe(
      undefined,
    );
  });
});

const SESSION = { sessionId: "sess-1", team: "org_a" };

describe("judgeJobStarterFor: the same choice, for a Judge run (#444)", () => {
  it.each([
    ["on Cloud Run", true],
    ["off Cloud Run", false],
  ])("runs the Cloud Run Job when one is named, %s", async (_name, behindCloudRun) => {
    const fake = fakes();
    const start = judgeJobStarterFor({ scanJob: JOB, behindCloudRun }, fake.deps);

    await start!(SESSION);

    expect(fake.fetched).toContain(`https://run.googleapis.com/v2/${JOB}:run`);
    expect(fake.spawned).toEqual([]);
  });

  it("runs the Job as a child process off Cloud Run when no Job is named", async () => {
    const fake = fakes();
    const start = judgeJobStarterFor({ scanJob: undefined, behindCloudRun: false }, fake.deps);

    await start!(SESSION);

    expect(fake.spawned).toHaveLength(1);
    expect(fake.fetched).toEqual([]);
  });

  it("wires none on Cloud Run when no Job is named", () => {
    const fake = fakes();
    expect(judgeJobStarterFor({ scanJob: undefined, behindCloudRun: true }, fake.deps)).toBe(
      undefined,
    );
  });
});

// The daily Job loads no server config, so it chooses from its own environment, which holds no model key (#499).
describe("dailyJudgeJobStarterFor: the daily Job's Judge run starter, from its environment", () => {
  it.each([
    ["in a Cloud Run Job", { CLOUD_RUN_JOB: "warden-daily-expiry" }],
    ["off Cloud Run", {}],
  ])("runs the Cloud Run Job WARDEN_SCAN_JOB names, %s", async (_name, env) => {
    const fake = fakes();
    const start = dailyJudgeJobStarterFor({ ...env, WARDEN_SCAN_JOB: JOB }, fake.deps);

    await start!(SESSION);

    expect(fake.fetched).toContain(`https://run.googleapis.com/v2/${JOB}:run`);
    expect(fake.spawned).toEqual([]);
  });

  it.each([
    ["unset", {}],
    ["empty, as .envrc exports a missing one", { WARDEN_SCAN_JOB: "" }],
  ])(
    "runs the Job as a child process off Cloud Run with WARDEN_SCAN_JOB %s",
    async (_name, env) => {
      const fake = fakes();
      const start = dailyJudgeJobStarterFor(env, fake.deps);

      await start!(SESSION);

      expect(fake.spawned).toHaveLength(1);
      expect(fake.fetched).toEqual([]);
    },
  );

  it("off Cloud Run, resolves a start only once its child has exited, so a sweep's runs go one at a time", async () => {
    const child = new EventEmitter();
    const spawn: Spawn = () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    const start = dailyJudgeJobStarterFor({}, { logger: createLogger(() => {}), spawn });
    let resolved = false;
    const started = start!(SESSION).then(() => {
      resolved = true;
    });

    await new Promise((settle) => setImmediate(settle));
    expect(resolved).toBe(false);

    child.emit("exit", 0, null);
    await started;
    expect(resolved).toBe(true);
  });

  it("wires none in a Cloud Run Job (CLOUD_RUN_JOB set) without WARDEN_SCAN_JOB", () => {
    const fake = fakes();
    expect(dailyJudgeJobStarterFor({ CLOUD_RUN_JOB: "warden-daily-expiry" }, fake.deps)).toBe(
      undefined,
    );
  });
});
