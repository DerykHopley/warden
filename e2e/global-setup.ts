// Before the browser tests: a throwaway Postgres database with every migration and Patch's CVE snapshot loaded (as the
// release does, so a Product's save opens its CVE Findings), a key pair standing in for Clerk's, the dashboard built in
// Vite's `e2e` mode, and the real server process on a free port serving that build, each Scan Job it starts held for a
// moment first (`scan-job-start-delay.ts`). The server has the write app's settings, with a key pair made for the run,
// and it and its Scan Jobs reach GitHub only through the fake (`fake-github.ts`, installed by `fake-github-preload.ts`),
// which logs each of the server's calls to a file in a temporary folder (`E2E_FAKE_GITHUB_LOG`, handed to the server
// and the test workers; a Scan Job doesn't get it, so the fake refuses its writes). Acme, Bluebird, Cedar, Dahlia, Elm
// and Fir are opened through the API as their Admins would (each Team's Member joins too); Cedar gets two Repo Assets
// and a stale Guard Scan of them (`seedCedarRepos`); Dahlia gets one Repo Asset, a write grant and an Open Finding for
// story 6's Fix PR (`seedDahliaFixPr`); Fir gets one Repo Asset and a Guard Scan of it with an Open Finding under
// 1.3.3 for the Control card (`seedFirControl`); Ginkgo gets two hook tokens, issued 50 and 25 hours before the run
// (`seedGinkgoHookTokens`, handed to the test workers as `E2E_HOOK_TOKENS`), and the server a pseudonym key made for
// the run, so the hook endpoint stores events (story 7); Acme and Bluebird are then filled by the demo seed (`server/src/seed.ts`)
// without its demo Product (`--no-product`), so the Findings their tests count stay the demo ones. Returns the
// teardown: the server stopped, the database dropped, the build and the fake's log removed.
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportJWK, exportSPKI, generateKeyPair } from "jose";
import { createPool } from "../server/src/database.ts";
import { createFindings } from "../server/src/findings/index.ts";
import { createLogger } from "../server/src/log.ts";
import { createHookSettings } from "../server/src/modules/guard/hook-settings.ts";
import { createRepoAssets } from "../server/src/modules/guard/repo-assets.ts";
import { createWriteGrants } from "../server/src/modules/guard/write-grants.ts";
import { MOVE_RULES } from "../server/src/wiring.ts";
import { createWithTeam } from "../server/src/with-team.ts";
import {
  createMigratedTestDatabase,
  loadTestCveSnapshot,
  waitForPostgres,
} from "../server/test/databases.ts";
import { OWNER_PGPORT, refuseOwnerDatabase } from "../server/test/owner-database.ts";
import {
  ACME,
  ANNIE,
  BARBARA,
  BLUEBIRD,
  CEDAR,
  CEDAR_REPOS,
  DAHLIA,
  DAHLIA_REPO,
  DOROTHY,
  ELM,
  EVELYN,
  FIR,
  FIR_REPO,
  FRANCES,
  FRONTEND_API_HOST,
  GINKGO,
  GRACE,
  HEDY,
  JOAN,
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

/** Runs `seed` with a `withTeam` on a one-connection warden_app pool to `database`, and ends the pool after it. */
async function withAppPool(
  connection: { host: string; port: number },
  database: string,
  seed: (withTeam: ReturnType<typeof createWithTeam>) => Promise<void>,
) {
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
    await seed(createWithTeam(pool));
  } finally {
    await pool.end();
  }
}

/**
 * Cedar's repos for story 2's Setup tests, as warden_app inside withTeam: its two Repo Assets, as Hedy's link of
 * installation 4242 would write them, and a Guard Scan of both queued 2 hours ago that never started.
 */
async function seedCedarRepos(connection: { host: string; port: number }, database: string) {
  await withAppPool(connection, database, async (withTeam) => {
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
  });
}

/** The installation of the read app Dahlia's Repo Asset is linked through: not one Cedar's or the Setup tests' use. */
const DAHLIA_READ_INSTALLATION = 5150;

/** The installation of the write app Dahlia's grant names: not one Cedar's or the Setup tests' links use. */
const DAHLIA_WRITE_INSTALLATION = 5151;

/**
 * Dahlia's Fix PR for story 6, as warden_app inside withTeam: its one Repo Asset, as Dorothy's link of a read-app
 * installation would write it; a write grant on another installation, as Dorothy's would; and one Open
 * `guard/agent-can-read-env` Finding at `.claude/settings.json` on that Asset, from a Guard Scan reconciled as the demo
 * seed's are.
 */
async function seedDahliaFixPr(connection: { host: string; port: number }, database: string) {
  await withAppPool(connection, database, async (withTeam) => {
    await createRepoAssets({ withTeam }).link(DAHLIA.id, {
      installationId: DAHLIA_READ_INSTALLATION,
      linkedBy: DOROTHY.userId,
      repos: [DAHLIA_REPO],
    });
    await createWriteGrants({ withTeam }).grant(DAHLIA.id, {
      installationId: DAHLIA_WRITE_INSTALLATION,
      grantedBy: DOROTHY.userId,
    });
    const path = ".claude/settings.json";
    const asset = { kind: "repo", ref: DAHLIA_REPO.ref } as const;
    await createFindings({ withTeam, moveRules: MOVE_RULES }).reconcile({
      id: "e2e-dahlia-guard-1",
      team: DAHLIA.id,
      module: "guard",
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      assets: [asset],
      rules: ["guard/agent-can-read-env"],
      observations: [
        {
          asset,
          rule_id: "guard/agent-can-read-env",
          location: { kind: "file", path },
          severity: "high",
          title: "The agent can read .env files",
          evidence: { summary: `permissions.allow in ${path} lets the agent read .env` },
        },
      ],
    });
  });
}

/** The installation Fir's Repo Asset is linked through: not one another Team's or the Setup tests' links use. */
const FIR_INSTALLATION = 5250;

/**
 * Fir's Control card for spec #341 (slice 7a), as warden_app inside withTeam: its one Repo Asset, as Frances's link
 * would write it, and a Guard Scan of it an hour ago under both of 1.3.3's Rules, reconciled as the demo seed's are,
 * with one Open `guard/unapproved-ai-tool` Finding: one Rule is Partly evidenced and the other Evidenced, so 1.3.3 is
 * Partly evidenced, "1 Open Finding on 1 Repo".
 */
async function seedFirControl(connection: { host: string; port: number }, database: string) {
  await withAppPool(connection, database, async (withTeam) => {
    await createRepoAssets({ withTeam }).link(FIR.id, {
      installationId: FIR_INSTALLATION,
      linkedBy: FRANCES.userId,
      repos: [FIR_REPO],
    });
    const asset = { kind: "repo", ref: FIR_REPO.ref } as const;
    await createFindings({ withTeam, moveRules: MOVE_RULES }).reconcile({
      id: "e2e-fir-guard-1",
      team: FIR.id,
      module: "guard",
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      assets: [asset],
      rules: ["guard/unapproved-ai-tool", "guard/mcp-server-unpinned"],
      observations: [
        {
          asset,
          rule_id: "guard/unapproved-ai-tool",
          location: { kind: "file", path: ".cursor" },
          severity: "medium",
          title: "Another AI tool's config is in the repo",
          evidence: { summary: "Cursor config in 1 path (.cursor/rules)." },
        },
      ],
    });
  });
}

/**
 * Ginkgo's hook tokens for story 7, as warden_app inside withTeam: one issued 50 hours ago and the next 25 hours ago, as
 * Barbara's rotations then would have written them. The older stopped working an hour ago, 24 hours after the newer.
 */
async function seedGinkgoHookTokens(
  connection: { host: string; port: number },
  database: string,
): Promise<{ issued50hAgo: string; issued25hAgo: string }> {
  const tokens: string[] = [];
  await withAppPool(connection, database, async (withTeam) => {
    for (const hoursAgo of [50, 25]) {
      const settings = createHookSettings({
        withTeam,
        now: () => Date.now() - hoursAgo * 3_600_000,
      });
      tokens.push((await settings.issueToken(GINKGO.id, { issuedBy: BARBARA.userId })).token);
    }
  });
  const [issued50hAgo, issued25hAgo] = tokens as [string, string];
  return { issued50hAgo, issued25hAgo };
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

    // The fake's log, which the server appends to and the test workers read.
    const fakeGitHub = mkdtempSync(join(tmpdir(), "warden-e2e-github-"));
    cleanup.push(() => rmSync(fakeGitHub, { recursive: true, force: true }));
    const githubLog = join(fakeGitHub, "calls.jsonl");
    writeFileSync(githubLog, "");
    // The write app's key for this run: only the fake ever sees what it signs.
    const writeAppKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const preload = (file: string) => `--import=${pathToFileURL(join(repoRoot, file)).href}`;

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
          // The write app, through the fake: its client secret is never sent, as no test signs in through it.
          GITHUB_WRITE_APP_CLIENT_ID: "Iv23li-e2e-writer",
          GITHUB_WRITE_APP_CLIENT_SECRET: "e2e-write-app-secret-unused",
          GITHUB_WRITE_APP_PRIVATE_KEY: writeAppKey,
          E2E_FAKE_GITHUB_LOG: githubLog,
          // A key made for this run, so the hook endpoint stores events (story 7): no other copy of it exists.
          WARDEN_PSEUDONYM_KEY: randomBytes(32).toString("hex"),
          // The Judge's model URL rule lets an Admin name localhost, so Setup can save one (#464). Nothing is called.
          WARDEN_JUDGE_LOCALHOST: "1",
          // Handed on to each Scan Job: the fake in both, and the delay, which holds a Scan Job before it runs and
          // lets the server run at once.
          NODE_OPTIONS: [
            preload("e2e/fake-github-preload.ts"),
            preload("e2e/scan-job-start-delay.ts"),
          ].join(" "),
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
    // Dahlia is story 6's alone (e2e/fix-pr.spec.ts): Annie, its Member, opens the Fix PR.
    await open(DAHLIA.admin, DAHLIA, "admin");
    await open(ANNIE, DAHLIA, "member");
    await seedDahliaFixPr(connection, database.name);
    // Elm is spec #341's stories 8 and 9's alone (e2e/overview.spec.ts): no seed, no Scan.
    await open(ELM.admin, ELM, "admin");
    await open(EVELYN, ELM, "member");
    // Fir is the Control card's alone (e2e/control-card.spec.ts): Joan, its Member, reads the review.
    await open(FIR.admin, FIR, "admin");
    await open(JOAN, FIR, "member");
    await seedFirControl(connection, database.name);
    // Ginkgo is story 7's alone (e2e/hook.spec.ts): two hook tokens, issued 50 and 25 hours ago.
    await open(BARBARA, GINKGO, "admin");
    const hookTokens = await seedGinkgoHookTokens(connection, database.name);
    for (const team of [ACME, BLUEBIRD]) {
      await run(process.execPath, ["server/src/seed.ts", team.id, "--no-product"], {
        ...db,
        WARDEN_SEED_DEMO: database.name,
      });
    }

    process.env.E2E_BASE_URL = origin;
    process.env.E2E_FAKE_GITHUB_LOG = githubLog;
    process.env.E2E_SIGNING_JWK = JSON.stringify(await exportJWK(privateKey));
    process.env.E2E_HOOK_TOKENS = JSON.stringify(hookTokens);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
