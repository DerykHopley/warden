// The local starter, over a fake spawn: it runs scan-job.ts with node, handing it the Scan's id and Team and the
// server's own PG* variables, HOME and Node's options, and nothing else from the server's environment. The Judge
// starter hands on the same, with the session's id in place of the Scan's, and the Judge's key, model and localhost
// setting.
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RSA_PRIVATE_KEY } from "../test/secret-fixtures.ts";
import { localJudgeJobStarter, localScanJobStarter, type Spawn } from "./local-scan-job-starter.ts";
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

  it("hands on neither the Judge's variables nor a session id, though the server has them", async () => {
    const fake = fakeSpawn();
    const { start } = starter(fake.spawn, { ...SERVER_ENV, ...JUDGE_ENV });

    const started = start({ scanId: "scan-1", team: "org_a" });
    fake.child.emit("spawn");
    await started;

    const env = fake.calls[0]!.env;
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("WARDEN_JUDGE_LOCALHOST");
    expect(env).not.toHaveProperty("WARDEN_SESSION_ID");
  });
});

/** The Judge's three variables, as the server's environment holds them locally. */
const JUDGE_ENV = {
  OPENROUTER_API_KEY: "sk-or-v1-the-judge-key",
  WARDEN_JUDGE_MODEL: "anthropic/claude-haiku-5.5",
  WARDEN_JUDGE_LOCALHOST: "1",
};

function judgeStarter(spawn: Spawn, env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const start = localJudgeJobStarter({
    logger: createLogger((line) => lines.push(line)),
    env,
    spawn,
  });
  return { start, lines };
}

const SESSION = { sessionId: "sess-1", team: "org_a" };

describe("localJudgeJobStarter (#444)", () => {
  it("runs scan-job.ts with the session's id and Team, the Judge's three variables, and the Scan Job's own", async () => {
    const fake = fakeSpawn();
    const { start } = judgeStarter(fake.spawn, {
      ...SERVER_ENV,
      ...JUDGE_ENV,
      GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
      GITHUB_APP_CLIENT_SECRET: "never-handed-on",
      CLERK_JWT_KEY: "never-handed-on",
      WARDEN_PSEUDONYM_KEY: "never-handed-on",
    });

    const started = start(SESSION);
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
          GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
          ...JUDGE_ENV,
          WARDEN_SESSION_ID: "sess-1",
          WARDEN_TEAM: "org_a",
        },
      },
    ]);
  });

  it("hands on neither Judge variable when the server has none", async () => {
    const fake = fakeSpawn();
    const { start } = judgeStarter(fake.spawn, SERVER_ENV);

    const started = start(SESSION);
    fake.child.emit("spawn");
    await started;

    const env = fake.calls[0]!.env;
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("WARDEN_JUDGE_MODEL");
    expect(env).not.toHaveProperty("WARDEN_JUDGE_LOCALHOST");
  });

  it("logs the run's exit with the Team and exit code, never the session id", async () => {
    const fake = fakeSpawn();
    const { start, lines } = judgeStarter(fake.spawn, SERVER_ENV);
    const started = start(SESSION);
    fake.child.emit("spawn");
    await started;

    fake.child.emit("exit", 1, null);

    expect(entries(lines)).toEqual([
      expect.objectContaining({ severity: "ERROR", team: "org_a", code: 1 }),
    ]);
    for (const line of lines) expect(line).not.toContain(SESSION.sessionId);
  });
});
