// Which Scan Job starter the server wires: the Cloud Run Job whenever one is named, the child process off Cloud Run
// otherwise, and none on Cloud Run without a Job (a start there answers 503). Each starter is told apart by what it
// calls: fetch for the Cloud Run Job, spawn for the child process.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Fetch } from "./cloud-run-scan-job-starter.ts";
import type { Spawn } from "./local-scan-job-starter.ts";
import { createLogger } from "./log.ts";
import { scanJobStarterFor } from "./scan-job-starters.ts";

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
    queueMicrotask(() => child.emit("spawn"));
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
