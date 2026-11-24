// Before the browser tests: a throwaway Postgres database with every migration, a key pair standing in for Clerk's,
// the dashboard built in Vite's `e2e` mode, and the real server process on a free port serving that build. Acme and
// Bluebird are opened through the API as their Admins would (Acme's Member joins too), then filled by the demo seed
// (`server/src/seed.ts`). Returns the teardown: the server stopped, the database dropped, the build removed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportSPKI, generateKeyPair } from "jose";
import { createMigratedTestDatabase } from "../server/test/databases.ts";
import {
  ACME,
  BLUEBIRD,
  FRONTEND_API_HOST,
  GRACE,
  sessionToken,
  type Person,
  type Team,
} from "./session.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The Postgres the server's tests use: the PG* variables, or the compose database. */
const postgres = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: process.env.PGPORT ?? "54329",
  user: process.env.PGUSER ?? "warden",
  database: process.env.PGDATABASE ?? "warden",
};

/** Runs a command from the repo root to the end; throws with its output when it fails. */
function run(command: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed:\n${output}`)),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
}

/** Starts `node server/src/index.ts` with only `env` (plus PATH and HOME), and waits for it to listen. */
async function startServer(env: Record<string, string>) {
  const { PATH = "", HOME = "" } = process.env;
  const child = spawn(process.execPath, ["server/src/index.ts"], {
    cwd: repoRoot,
    env: { PATH, HOME, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 200; i++) {
    if (output.includes('"message":"listening"')) return { child, exited };
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`the server didn't start:\n${output}`);
}

export default async function globalSetup() {
  const cleanup: (() => Promise<unknown> | void)[] = [];
  const teardown = async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  };
  try {
    const database = await createMigratedTestDatabase({
      ...postgres,
      port: Number(postgres.port),
    });
    cleanup.push(database.drop);

    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

    const dashboard = mkdtempSync(join(tmpdir(), "warden-e2e-dashboard-"));
    cleanup.push(() => rmSync(dashboard, { recursive: true, force: true }));
    await run("pnpm", [
      "--filter",
      "@warden/dashboard",
      "exec",
      "vite",
      "build",
      "--mode",
      "e2e",
      "--outDir",
      dashboard,
      "--emptyOutDir",
    ]);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const db = {
      PGHOST: postgres.host,
      PGPORT: postgres.port,
      PGUSER: "warden_app",
      PGDATABASE: database.name,
    };
    const server = await startServer({
      ...db,
      PORT: String(port),
      // Never used: the stand-in's tokens are checked with CLERK_JWT_KEY, and no test changes an Admin's Role.
      CLERK_SECRET_KEY: "sk_test_unused_by_the_browser_tests",
      CLERK_JWT_KEY: await exportSPKI(publicKey),
      VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64")}`,
      CLERK_AUTHORIZED_PARTIES: origin,
      WARDEN_DASHBOARD_DIR: dashboard,
    });
    cleanup.push(async () => {
      server.child.kill();
      await server.exited;
    });

    // Opening Warden as each Team's Admin creates the Team; Grace's first visit joins Acme as a Member.
    const open = async (person: Person, team: Team, role: "admin" | "member") => {
      const token = await sessionToken(privateKey, origin, person, team, role);
      const res = await fetch(`${origin}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`opening ${team.name} as ${person.userId}: ${res.status}`);
    };
    await open(ACME.admin, ACME, "admin");
    await open(GRACE, ACME, "member");
    await open(BLUEBIRD.admin, BLUEBIRD, "admin");
    for (const team of [ACME, BLUEBIRD]) {
      await run(process.execPath, ["server/src/seed.ts", team.id], db);
    }

    process.env.E2E_BASE_URL = origin;
    process.env.E2E_SIGNING_JWK = JSON.stringify(await exportJWK(privateKey));
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
