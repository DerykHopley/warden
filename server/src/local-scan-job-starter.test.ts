// The local starter, over a fake spawn: it runs scan-job.ts with node, handing it the Scan's id and Team and the
// server's own PG* variables, HOME and Node's options, and nothing else from the server's environment.
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RSA_PRIVATE_KEY } from "../test/secret-fixtures.ts";
import { localScanJobStarter, type Spawn } from "./local-scan-job-starter.ts";
import { createLogger } from "./log.ts";

const SERVER_ENV = {
  PGHOST: "127.0.0.1",
  PGPORT: "5432",
  PGUSER: "warden_app",
  PGDATABASE: "warden",
  PGPASSWORD: "the-app-password",
  HOME: "/home/warden",
  NODE_OPTIONS: "--max-old-space-size=512",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
  PATH: "/usr/bin",
  CLERK_SECRET_KEY: "sk_test_never_handed_on",
  WARDEN_ADMIN_PASSWORD: "never-handed-on",
};

function fakeSpawn() {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const child = new EventEmitter();
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return child;
  };
  return { calls, child, spawn };
}

function starter(spawn: Spawn, env: NodeJS.ProcessEnv = SERVER_ENV) {
  const lines: string[] = [];
  const start = localScanJobStarter({
    logger: createLogger((line) => lines.push(line)),
    env,
    spawn,
  });
  return { start, lines };
}

const entries = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("localScanJobStarter", () => {
  it("runs scan-job.ts with node, the Scan's id and Team, and only the server's PG* and Node variables", async () => {
    const fake = fakeSpawn();
    const { start } = starter(fake.spawn);

    const started = start({ scanId: "scan-1", team: "org_a" });
    fake.child.emit("spawn");
    await started;

    expect(fake.calls).toEqual([
      {
        command: process.execPath,
        args: [fileURLToPath(new URL("./scan-job.ts", import.meta.url))],
        env: {
          PGHOST: "127.0.0.1",
          PGPORT: "5432",
          PGUSER: "warden_app",
          PGDATABASE: "warden",
          PGPASSWORD: "the-app-password",
          HOME: "/home/warden",
          NODE_OPTIONS: "--max-old-space-size=512",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
          WARDEN_SCAN_ID: "scan-1",
          WARDEN_TEAM: "org_a",
        },
      },
    ]);
  });

  it("hands on the GitHub App's client id and private key, never its client secret", async () => {
    const fake = fakeSpawn();
    const { start } = starter(fake.spawn, {
      ...SERVER_ENV,
      GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
      GITHUB_APP_PRIVATE_KEY: RSA_PRIVATE_KEY,
      GITHUB_APP_CLIENT_SECRET: "never-handed-on",
    });

    const started = start({ scanId: "scan-1", team: "org_a" });
    fake.child.emit("spawn");
    await started;

    expect(fake.calls).toHaveLength(1);
    const env = fake.calls[0]!.env;
    expect(env).toMatchObject({
      GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
      GITHUB_APP_PRIVATE_KEY: expect.stringContaining("the-key"),
    });
    expect(env).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
  });

  it("is refused when the process can't be started", async () => {
    const fake = fakeSpawn();
    const { start } = starter(fake.spawn);

    const started = start({ scanId: "scan-1", team: "org_a" });
    fake.child.emit("error", new Error("spawn ENOENT"));

    await expect(started).rejects.toThrow("spawn ENOENT");
  });

  it("logs the Job's exit with the Scan's id, Team and exit code, without waiting for it", async () => {
    const fake = fakeSpawn();
    const { start, lines } = starter(fake.spawn);
    const started = start({ scanId: "scan-1", team: "org_a" });
    fake.child.emit("spawn");
    await started;
    expect(lines).toEqual([]);

    fake.child.emit("exit", 1, null);

    expect(entries(lines)).toContainEqual(
      expect.objectContaining({ severity: "ERROR", scanId: "scan-1", team: "org_a", code: 1 }),
    );
  });
});
