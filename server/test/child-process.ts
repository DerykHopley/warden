// Commands the tests run as processes of their own: run to the end with their output kept, and the clean environment
// a child gets when it must see nothing of this run's own (no CI, no PG*).
import { spawn } from "node:child_process";

/** `env` plus only PATH and HOME from this run's environment. A key `env` gives as undefined is left out. */
export function cleanEnvironment(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const { PATH, HOME } = process.env;
  return { PATH, HOME, ...env };
}

/** Runs `command` in `cwd` as its own process, to the end, with `env` over this run's environment, or with `clean`
 * over only PATH and HOME (`cleanEnvironment`). Its stdin is closed, so nothing waits on it. It answers the exit code
 * and the output, both streams as they came in `output`, and each apart in `stdout` and `stderr`. A command that
 * can't start fails the test with the spawn error. */
export function runCommand(
  [command, ...args]: [string, ...string[]],
  env: Record<string, string | undefined>,
  { cwd, clean = false }: { cwd: string; clean?: boolean },
) {
  const child = spawn(command, args, {
    cwd,
    env: clean ? cleanEnvironment(env) : { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
    stderr += chunk;
  });
  return new Promise<{ code: number | null; output: string; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", (error) => reject(new Error(`couldn't run ${command}`, { cause: error })));
      child.on("close", (code) => resolve({ code, output, stdout, stderr }));
    },
  );
}
