// Starts the spike as a process, the way Cloud Run does, on a spare port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const SECRET = "s3cr3t-value-for-the-test";

type Line = Record<string, unknown>;

function start(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [main, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Line[] = [];
  let raw = "";
  child.stdout.on("data", (chunk: Buffer) => {
    raw += chunk.toString();
    const parts = raw.split("\n");
    raw = parts.pop() ?? "";
    for (const part of parts) if (part) lines.push(JSON.parse(part) as Line);
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, lines, exited, stdout: () => JSON.stringify(lines) };
}

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stop(child: ChildProcess) {
  child.kill("SIGKILL");
}

const port = String(18000 + Math.floor(Math.random() * 1000));
const base = `http://127.0.0.1:${port}`;

test("serve mode: start returns at once, task retries, inline ticks, secret length only", async (t) => {
  const server = start(["serve"], { PORT: port, SPIKE_SECRET: SECRET, TICK_MS: "20" });
  t.after(() => stop(server.child));
  await until(() => server.lines.some((line) => line.message === "instance started"));
  const started = server.lines.find((line) => line.message === "instance started");
  assert.equal(started?.secret, `secret found, length ${SECRET.length}`);

  // /start answers before the work ends, and the work goes on after the response.
  const before = Date.now();
  const startResponse = await fetch(`${base}/start`, {
    method: "POST",
    body: JSON.stringify({ scanId: "scan-bg", team: "team-a", seconds: 0.2 }),
  });
  assert.equal(startResponse.status, 202);
  assert.ok(Date.now() - before < 150, "start should answer before the work ends");
  await until(() =>
    server.lines.some((line) => line.message === "work finished" && line.scanId === "scan-bg"),
  );

  // /task: 500 to the first delivery of a Scan id, 200 to the next; Cloud Tasks headers logged.
  const task = { scanId: "scan-task", team: "team-a", seconds: 0, failFirstDelivery: true };
  const first = await fetch(`${base}/task`, {
    method: "POST",
    headers: { "x-cloudtasks-taskretrycount": "0", "x-cloudtasks-taskname": "t1" },
    body: JSON.stringify(task),
  });
  const second = await fetch(`${base}/task`, {
    method: "POST",
    headers: { "x-cloudtasks-taskretrycount": "1", "x-cloudtasks-taskname": "t1" },
    body: JSON.stringify(task),
  });
  assert.equal(first.status, 500);
  assert.equal(second.status, 200);
  const deliveries = server.lines.filter((line) => line.message === "task delivery");
  assert.deepEqual(
    deliveries.map((line) => [line.scanId, line.answer, line.taskRetryCount]),
    [
      ["scan-task", 500, "0"],
      ["scan-task", 200, "1"],
    ],
  );

  // /task refuses a Scan with no Team with a 400, logged as "task refused".
  const noTeam = await fetch(`${base}/task`, {
    method: "POST",
    body: JSON.stringify({ scanId: "scan-x", seconds: 0 }),
  });
  assert.equal(noTeam.status, 400);

  // /inline ticks before it answers.
  const inline = await fetch(`${base}/inline`, {
    method: "POST",
    body: JSON.stringify({ scanId: "scan-inline", team: "team-a", seconds: 0.1 }),
  });
  assert.equal(inline.status, 200);
  assert.ok(
    server.lines.some((line) => line.message === "work finished" && line.scanId === "scan-inline"),
  );

  // Every request end is logged, so the idle time before SIGTERM can be measured.
  assert.ok(server.lines.some((line) => line.message === "request done"));
  assert.ok(!server.stdout().includes(SECRET), "the secret's value must never be printed");
});

test("serve mode logs SIGTERM with how long the instance was idle", async (t) => {
  const server = start(["serve"], { PORT: String(Number(port) + 1), TICK_MS: "20" });
  t.after(() => stop(server.child));
  await until(() => server.lines.some((line) => line.message === "instance started"));
  server.child.kill("SIGTERM");
  await until(() => server.lines.some((line) => line.message === "SIGTERM received"));
  const sigterm = server.lines.find((line) => line.message === "SIGTERM received");
  assert.equal(typeof sigterm?.idleSeconds, "number");
  assert.equal(typeof sigterm?.uptimeSeconds, "number");
});

test("job mode runs the Scan passed in SCAN and exits 0", async () => {
  const job = start(["job"], {
    SCAN: JSON.stringify({ scanId: "scan-job", team: "team-a", seconds: 0.1 }),
    SPIKE_SECRET: SECRET,
    TICK_MS: "20",
    CLOUD_RUN_TASK_ATTEMPT: "0",
  });
  assert.equal(await job.exited, 0);
  const started = job.lines.find((line) => line.message === "job started");
  assert.equal(started?.scanId, "scan-job");
  assert.equal(started?.attempt, 0);
  assert.equal(started?.secret, `secret found, length ${SECRET.length}`);
  assert.equal(typeof started?.processUptimeMs, "number");
  assert.ok(job.lines.some((line) => line.message === "work finished"));
  assert.ok(!job.stdout().includes(SECRET));
});

test("job mode fails the first attempt when asked, and runs the same Scan on the retry", async () => {
  const scan = JSON.stringify({
    scanId: "scan-retry",
    team: "team-a",
    seconds: 0,
    failFirstAttempt: true,
  });
  const first = start(["job"], { SCAN: scan, CLOUD_RUN_TASK_ATTEMPT: "0" });
  assert.equal(await first.exited, 1);
  const retry = start(["job"], { SCAN: scan, CLOUD_RUN_TASK_ATTEMPT: "1" });
  assert.equal(await retry.exited, 0);
  assert.ok(
    retry.lines.some((line) => line.message === "job started" && line.scanId === "scan-retry"),
  );
});

test("job mode refuses a Scan with no Team and exits non-zero", async () => {
  const job = start(["job"], { SCAN: JSON.stringify({ scanId: "s", seconds: 0 }) });
  assert.equal(await job.exited, 2);
  assert.ok(
    job.lines.some((line) => line.message === "job refused" && /no Team/.test(String(line.reason))),
  );
});
