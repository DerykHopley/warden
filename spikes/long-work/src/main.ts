// The long-work spike (#14): one image, two modes. Throwaway: this branch is never merged.
//
//   node main.ts serve   a Cloud Run service (options A and B)
//   node main.ts job     a Cloud Run Job task (option C): runs the Scan in the SCAN env var, then exits
//
// Every line is one JSON object on stdout, which Cloud Logging reads as a structured entry.
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { createDeliveries, parseScan, runTicks, secretReport, type LogFields } from "./work.ts";

const instance = randomBytes(4).toString("hex");
const processStartedAt = Date.now();
const intervalMs = Number(process.env.TICK_MS ?? 10_000);

function log(fields: LogFields) {
  const line = {
    severity: "INFO",
    at: new Date().toISOString(),
    instance,
    service: process.env.K_SERVICE ?? process.env.CLOUD_RUN_JOB,
    revision: process.env.K_REVISION ?? process.env.CLOUD_RUN_EXECUTION,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

function cloudTasksHeaders(request: IncomingMessage) {
  const header = (name: string) => request.headers[name] as string | undefined;
  return {
    queueName: header("x-cloudtasks-queuename"),
    taskName: header("x-cloudtasks-taskname"),
    taskRetryCount: header("x-cloudtasks-taskretrycount"),
    taskExecutionCount: header("x-cloudtasks-taskexecutioncount"),
    taskEta: header("x-cloudtasks-tasketa"),
    taskPreviousResponse: header("x-cloudtasks-taskpreviousresponse"),
    taskRetryReason: header("x-cloudtasks-taskretryreason"),
  };
}

function serve() {
  const deliveries = createDeliveries();
  let lastRequestDoneAt = Date.now();
  let inFlight = 0;
  let working = 0;

  const server = createServer(async (request, response) => {
    const path = request.url?.split("?")[0];
    const receivedAt = Date.now();
    inFlight += 1;
    let status = 500;
    try {
      if (request.method === "GET" && path === "/") {
        status = 200;
        response.writeHead(status, { "content-type": "text/plain" }).end(`ok ${instance}\n`);
      } else if (request.method === "POST" && path === "/start") {
        // Option A: answer at once, keep working in this instance.
        const scan = parseScan(await body(request));
        working += 1;
        void runTicks(scan, { intervalMs, log }).finally(() => (working -= 1));
        status = 202;
        response.writeHead(status).end(`started ${scan.scanId} on ${instance}\n`);
      } else if (request.method === "POST" && path === "/inline") {
        // Option A at the request limit: the work runs inside the request.
        const scan = parseScan(await body(request));
        request.on("close", () => {
          if (!response.writableEnded) log({ message: "caller went away", scanId: scan.scanId });
        });
        await runTicks(scan, { intervalMs, log });
        status = 200;
        response.writeHead(status).end(`finished ${scan.scanId}\n`);
      } else if (request.method === "POST" && path === "/task") {
        // Option B: Cloud Tasks calls back with an OIDC token (checked by Cloud Run, not here).
        let scan;
        try {
          scan = parseScan(await body(request));
        } catch (error) {
          status = 400;
          log({ message: "task refused", reason: String(error), ...cloudTasksHeaders(request) });
          response.writeHead(status).end(`${String(error)}\n`);
          return;
        }
        status = scan.failFirstDelivery ? deliveries.decide(scan.scanId) : 200;
        log({
          message: "task delivery",
          scanId: scan.scanId,
          team: scan.team,
          answer: status,
          ...cloudTasksHeaders(request),
        });
        request.on("close", () => {
          if (!response.writableEnded) log({ message: "caller went away", scanId: scan.scanId });
        });
        if (status === 200) await runTicks(scan, { intervalMs, log });
        response.writeHead(status).end(`${status} ${scan.scanId}\n`);
      } else {
        status = 404;
        response.writeHead(status).end("not found\n");
      }
    } catch (error) {
      status = 400;
      if (!response.headersSent) response.writeHead(status).end(`${String(error)}\n`);
    } finally {
      inFlight -= 1;
      lastRequestDoneAt = Date.now();
      log({
        message: "request done",
        method: request.method,
        path,
        status,
        ms: Date.now() - receivedAt,
      });
    }
  });

  process.on("SIGTERM", () => {
    // Keep running: Cloud Run sends SIGKILL 10 seconds later, and any ticks in between show in the log.
    log({
      message: "SIGTERM received",
      uptimeSeconds: Math.round((Date.now() - processStartedAt) / 1000),
      idleSeconds: Math.round((Date.now() - lastRequestDoneAt) / 1000),
      inFlight,
      working,
    });
  });

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    log({
      message: "instance started",
      mode: "serve",
      port,
      secret: secretReport(process.env.SPIKE_SECRET),
    });
  });
}

async function job() {
  const attempt = Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0);
  let scan;
  try {
    scan = parseScan(JSON.parse(process.env.SCAN ?? "null"));
  } catch (error) {
    log({ message: "job refused", reason: String(error), attempt });
    process.exitCode = 2;
    return;
  }
  log({
    message: "job started",
    scanId: scan.scanId,
    team: scan.team,
    attempt,
    taskIndex: Number(process.env.CLOUD_RUN_TASK_INDEX ?? 0),
    processUptimeMs: Math.round(performance.now()),
    secret: secretReport(process.env.SPIKE_SECRET),
  });
  process.on("SIGTERM", () => log({ message: "SIGTERM received", scanId: scan.scanId, attempt }));
  if (scan.failFirstAttempt && attempt === 0) {
    log({ message: "job failing on purpose", scanId: scan.scanId, attempt });
    process.exitCode = 1;
    return;
  }
  await runTicks(scan, { intervalMs, log });
  log({ message: "job finished", scanId: scan.scanId, attempt });
}

const mode = process.argv[2] ?? "serve";
if (mode === "job") await job();
else serve();
