// The real server as its own process, for the start-up tests: started with only the environment given (plus PATH
// and HOME), its output kept, and killed after each test.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const children: ChildProcess[] = [];
afterEach(() => {
  children.splice(0).forEach((child) => child.kill());
});

export function startServer(env: Record<string, string>) {
  const { PATH, HOME } = process.env;
  const child = spawn(process.execPath, [entry], { env: { PATH, HOME, ...env } });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, exited, output: () => output };
}

/**
 * Where the test's Postgres is, for the server's environment: PGHOST, PGPORT (`port` when given) and PGPASSWORD, each
 * only when set, so an unset one stays unset (pg's default) rather than an empty string.
 */
export function pgConnection(port = process.env.PGPORT): Record<string, string> {
  const { PGHOST, PGPASSWORD } = process.env;
  return {
    ...(PGHOST ? { PGHOST } : {}),
    ...(port ? { PGPORT: port } : {}),
    ...(PGPASSWORD ? { PGPASSWORD } : {}),
  };
}

export async function waitForListening(output: () => string) {
  for (let i = 0; i < 100; i++) {
    if (output().includes('"message":"listening"')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output()}`);
}
