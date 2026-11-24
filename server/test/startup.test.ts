// The real server process: its configuration check at start-up, staying up when the database is gone, and
// shutting down cleanly.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testPublishableKey } from "./helpers.ts";
import { closedPort } from "./ports.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const children: ChildProcess[] = [];
afterEach(() => {
  children.splice(0).forEach((child) => child.kill());
});

function start(env: Record<string, string>) {
  const { PATH, HOME } = process.env;
  const child = spawn(process.execPath, [entry], { env: { PATH, HOME, ...env } });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, exited, output: () => output };
}

/** A server whose database refuses connections, listening on a spare port. */
async function startWithoutDatabase() {
  const port = await closedPort();
  const server = start({
    CLERK_SECRET_KEY: "clerk-secret-value",
    VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
    PGHOST: "127.0.0.1",
    PGPORT: String(await closedPort()),
    PGUSER: "warden",
    PGDATABASE: "warden",
    PORT: String(port),
  });
  await waitForListening(server.output);
  return { ...server, port };
}

describe("start-up", () => {
  it("exits 1 naming a missing required variable", async () => {
    const server = start({
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      PGHOST: "127.0.0.1",
      PGUSER: "warden",
      PGDATABASE: "warden",
    });

    expect(await server.exited).toBe(1);
    const entry = JSON.parse(server.output().trim().split("\n").at(-1) ?? "");
    expect(entry).toMatchObject({ severity: "ERROR", variables: ["CLERK_SECRET_KEY"] });
  });

  it("stays up and answers 503 while the database can't be reached", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);

    expect(res.status).toBe(503);
    expect(server.child.exitCode).toBeNull();
  });

  it("exits 0 on SIGTERM", async () => {
    const server = await startWithoutDatabase();

    server.child.kill("SIGTERM");

    expect(await server.exited).toBe(0);
  });
});

async function waitForListening(output: () => string) {
  for (let i = 0; i < 100; i++) {
    if (output().includes('"message":"listening"')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output()}`);
}
