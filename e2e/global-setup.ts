// Before the browser tests: a throwaway Postgres database with every migration and Patch's CVE snapshot loaded (as the
// release does, so a Product's save opens its CVE Findings), a key pair standing in for Clerk's, the dashboard built in
// Vite's `e2e` mode, and the real server process on a free port serving that build, each Scan Job it starts held for a
// moment first (`scan-job-start-delay.ts`). Acme, Bluebird and Cedar are opened through the API as their Admins would
// (each Team's Member joins too); Cedar gets two Repo Assets and a stale Guard Scan of them (`seedCedarRepos`); Acme
// and Bluebird are then filled by the demo seed (`server/src/seed.ts`) without its demo Product (`--no-product`), so
// the Findings their tests count stay the demo ones. Returns the teardown: the server stopped, the database dropped,
// the build removed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportJWK, exportSPKI, generateKeyPair } from "jose";
import { createPool } from "../server/src/database.ts";
import { createLogger } from "../server/src/log.ts";
import { createRepoAssets } from "../server/src/modules/guard/repo-assets.ts";
import { createWithTeam } from "../server/src/with-team.ts";
import {
  createMigratedTestDatabase,
  loadTestCveSnapshot,
  waitForPostgres,
} from "../server/test/databases.ts";
import { OWNER_PGPORT, refuseOwnerDatabase } from "../server/test/owner-database.ts";
import {
  ACME,
  BLUEBIRD,
  CEDAR,
  CEDAR_REPOS,
  FRONTEND_API_HOST,
  GRACE,
  HEDY,
  KATHERINE,
  MARGARET,
  sessionToken,
  type Person,
  type Team,
} from "./session.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The Postgres the server's tests use: the PG* variables, or the compose database (refused outside CI unless asked). */
const postgres = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: process.env.PGPORT ?? OWNER_PGPORT,
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

/**
 * Cedar's repos for story 2's Setup tests, as warden_app inside withTeam: its two Repo Assets, as Hedy's link of
 * installation 4242 would write them, and a Guard Scan of both queued 2 hours ago that never started.
 */
async function seedCedarRepos(connection: { host: string; port: number }, database: string) {
  const pool = createPool(
    createLogger(() => {}),
    {
      ...connection,
      user: "warden_app",
      database,
      max: 1,
    },
  );
  try {
    const withTeam = createWithTeam(pool);
    await createRepoAssets({ withTeam }).link(CEDAR.id, {
      installationId: 4242,
      linkedBy: HEDY.userId,
      repos: CEDAR_REPOS.map((ref, i) => ({ ref, githubId: i + 1 })),
    });
    // Written straight to the table, as the server's Scan tests do: `queued_at` is set once, on insert.
    await withTeam(CEDAR.id, (tx) =>
      tx
        .insertInto("scan_requests")
        .values({
          team_id: CEDAR.id,
          id: randomUUID(),
          module: "guard",
          assets: JSON.stringify(CEDAR_REPOS.map((ref) => ({ kind: "repo", ref }))),
          rules: ["guard/secret-in-repo"],
          requested_by: HEDY.userId,
          queued_at: new Date(Date.now() - 2 * 3_600_000),
        })
        .execute(),
    );
  } finally {
    await pool.end();
  }
}

export default async function globalSetup() {
  const cleanup: (() => Promise<unknown> | void)[] = [];
  const teardown = async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  };
  try {
    refuseOwnerDatabase(postgres.port, "pnpm e2e"); // outside CI, unless asked (#286)
    const connection = { ...postgres, port: Number(postgres.port) };
    await waitForPostgres(connection); // a container started just before the run (#236)
    const database = await createMigratedTestDatabase(connection);
    cleanup.push(database.drop);
    // As warden_migrate, before the server starts: what the release does after migrating.
    await loadTestCveSnapshot(database.name, connection);

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

    const db = {
      PGHOST: postgres.host,
      PGPORT: postgres.port,
      PGUSER: "warden_app",
      PGDATABASE: database.name,
    };
    const jwtKey = await exportSPKI(publicKey);
    // A free port can be taken by another process before the server binds it: then once more, on another.
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let origin = "";
    for (let attempt = 1; server === undefined; attempt++) {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      try {
        server = await startServer({
          ...db,
          PORT: String(port),
          // Never used: the stand-in's tokens are checked with CLERK_JWT_KEY, and no test changes an Admin's Role.
          CLERK_SECRET_KEY: "sk_test_unused_by_the_browser_tests",
          CLERK_JWT_KEY: jwtKey,
          VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64")}`,
          CLERK_AUTHORIZED_PARTIES: origin,
          WARDEN_DASHBOARD_DIR: dashboard,
          // Handed on to each Scan Job, which it holds before the Job runs; the server runs at once.
          NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, "e2e/scan-job-start-delay.ts")).href}`,
        });
      } catch (error) {
        if (attempt > 1 || !String(error).includes("EADDRINUSE")) throw error;
      }
    }
    cleanup.push(async () => {
      server!.child.kill();
      await server!.exited;
    });

    // Opening Warden as each Team's Admin creates the Team; Grace's first visit joins Acme as a Member, and Margaret's
    // joins Bluebird as one.
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
    await open(MARGARET, BLUEBIRD, "member");
    // Cedar gets no demo seed: the Products tests create its Products, and their saves open its CVE Findings.
    await open(CEDAR.admin, CEDAR, "admin");
    await open(KATHERINE, CEDAR, "member");
    await seedCedarRepos(connection, database.name);
    for (const team of [ACME, BLUEBIRD]) {
      await run(process.execPath, ["server/src/seed.ts", team.id, "--no-product"], {
        ...db,
        WARDEN_SEED_DEMO: database.name,
      });
    }

    process.env.E2E_BASE_URL = origin;
    process.env.E2E_SIGNING_JWK = JSON.stringify(await exportJWK(privateKey));
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
