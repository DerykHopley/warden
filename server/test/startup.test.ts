// The real server process: its configuration check at start-up, and staying up when the database is gone.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closedPort } from "./ports.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const publishableKey = `pk_test_${Buffer.from("warden-test.clerk.accounts.dev$").toString("base64")}`;

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

describe("start-up", () => {
  it("exits 1 naming a missing required variable, printing no variable's value", async () => {
    const values = {
      VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
      PGHOST: "pghost-value-1",
      PGUSER: "pguser-value-2",
      PGDATABASE: "pgdatabase-value-3",
      PGPASSWORD: "pgpassword-value-4",
    };
    const server = start(values);

    expect(await server.exited).toBe(1);
    const lines = server.output().trim().split("\n");
    const entry = JSON.parse(lines.at(-1) ?? "");
    expect(entry).toMatchObject({ severity: "ERROR", variables: ["CLERK_SECRET_KEY"] });
    expect(entry.message).toContain("CLERK_SECRET_KEY");
    for (const value of Object.values(values)) expect(server.output()).not.toContain(value);
  });

  it("stays up and answers 503 while the database can't be reached", async () => {
    const port = await closedPort();
    const server = start({
      CLERK_SECRET_KEY: "clerk-secret-value",
      VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
      PGHOST: "127.0.0.1",
      PGPORT: String(await closedPort()),
      PGUSER: "warden",
      PGDATABASE: "warden",
      PORT: String(port),
    });
    await waitForListening(server.output);

    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ database: "unreachable" });
    }
    expect(server.child.exitCode).toBeNull();
    expect(server.output()).not.toContain("clerk-secret-value");
  });
});

async function waitForListening(output: () => string) {
  for (let i = 0; i < 100; i++) {
    if (output().includes('"message":"listening"')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output()}`);
}
