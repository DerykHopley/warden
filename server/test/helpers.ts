// Test seams: a key pair standing in for a Clerk instance, and an app wired as production wires it.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type pg from "pg";
import {
  fingerprint,
  type Asset,
  type Finding,
  type HealthBody,
  type Module,
  type ProductInput,
  type Role,
} from "@warden/contracts";
import type { Hono } from "hono";
import { sql } from "kysely";
import { createApp, type AppEnv, type MountRoutes } from "../src/app.ts";
import { createClerkVerifier } from "../src/auth.ts";
import {
  createFindings,
  DAILY_JOB_LIMITS,
  type Findings,
  type TransactionLimits,
} from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { createMembers, type ClerkOrganizations, type Members } from "../src/members.ts";
import type { HookTables } from "../src/modules/guard/hook-settings.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import type { RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { createPatchAssessment } from "../src/modules/patch/assessment.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { createPatchRefresh, type PatchRefresh } from "../src/modules/patch/refresh.ts";
import { patchRoutes } from "../src/modules/patch/routes.ts";
import { createSaveLimit, type SaveLimit } from "../src/modules/patch/save-limit.ts";
import { createPatchScan, PATCH_RULE, type PatchScan } from "../src/modules/patch/scan.ts";
import {
  createScans,
  type AssetChecks,
  type ScanJobStarter,
  type Scanners,
  type Scans,
} from "../src/scans.ts";
import type { WithTeam } from "../src/with-team.ts";

/** Each module's move rule, as the start-up file wires them. */
const MOVE_RULES = { guard: guardMoveRule, patch: patchMoveRule };

/** A logger that keeps nothing, for a test that doesn't read the log. */
const silent = () => createLogger(() => {});

/**
 * The Patch Scan as the start-up file wires it: reporting to a Findings module with the start-up file's move rules,
 * on `withTeam`. `logger` takes its log lines (none are kept unless given). `limits` are its transaction's, as the
 * daily Job gives them (a save's Scan has none).
 */
export function patchScan(
  withTeam: WithTeam,
  logger: Logger = silent(),
  limits?: TransactionLimits,
): PatchScan {
  return createPatchScan({
    findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
    logger,
    limits,
  });
}

/**
 * Patch's daily step as the daily Job wires it: the Products store and the Patch Scan, on `withTeam`. `logger` takes
 * the step's and the Scans' log lines; `limits` stand in for the Job's (DAILY_JOB_LIMITS by default).
 */
export function patchRefresh(
  withTeam: WithTeam,
  logger: Logger = silent(),
  limits: TransactionLimits = DAILY_JOB_LIMITS,
): PatchRefresh {
  const findings = createFindings({ withTeam, moveRules: MOVE_RULES });
  return createPatchRefresh({
    products: createProducts({ withTeam }),
    findings,
    scan: createPatchScan({ findings, logger, limits }),
    logger,
  });
}

/**
 * Patch's routes as the start-up file mounts them: the Products store, the Patch Scan and the assessment, on
 * `withTeam`. `scan` stands in for the Patch Scan; `logger` takes the routes' log lines (none are kept unless given);
 * `saveLimit` stands in for the start-up file's (a fresh one by default); `now` is the assessment's clock (the real
 * time by default).
 */
export function patchMount(
  withTeam: WithTeam,
  {
    scan,
    logger = silent(),
    saveLimit = createSaveLimit(),
    now,
  }: { scan?: PatchScan; logger?: Logger; saveLimit?: SaveLimit; now?: () => Date } = {},
): MountRoutes {
  return patchRoutes({
    products: createProducts({ withTeam }),
    scan: scan ?? patchScan(withTeam, logger),
    assessment: createPatchAssessment({
      findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
      withTeam,
      now,
    }),
    logger,
    saveLimit,
  });
}

/**
 * Resolves once a transaction is waiting for the advisory lock `pg_advisory_xact_lock(hashtextextended(key, 0))`
 * takes, read through `probe`'s view of `pg_locks`. `what` names the lock in the error when none is queued.
 */
export async function queuedBehindLock(probe: pg.Pool, key: string, what: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    const { rows } = await probe.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_locks
        where locktype = 'advisory' and not granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [key],
    );
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nothing queued behind ${what}`);
}

/**
 * Resolves once a transaction is waiting for `team`'s Findings lock (the one reconcile and decisions take), read
 * through `probe`'s view of `pg_locks`.
 */
export const queuedBehindFindingsLock = (probe: pg.Pool, team: string) =>
  queuedBehindLock(probe, team, "the Team's Findings lock");

export const FRONTEND_API_HOST = "warden-test.clerk.accounts.dev";

/** The dashboard origin test tokens are made for (their `azp`), and the one the test app accepts. */
export const DASHBOARD_ORIGIN = "http://localhost:5173";

/** A publishable key naming FRONTEND_API_HOST, as Clerk encodes it: base64 of `<host>$`. */
export const testPublishableKey = `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64")}`;

/** A signing key and its PEM public key, as Clerk's dashboard shows it for networkless verification. */
export async function testKey() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return { privateKey, publicPem: await exportSPKI(publicKey) };
}

let appKey: string | undefined;

/**
 * A GitHub App's private key as GitHub downloads it: a 2048-bit RSA PKCS#1 PEM, `BEGIN RSA PRIVATE KEY`. Made once per
 * test file, on first use, since an RSA key takes a moment to generate.
 */
export function gitHubAppKey(): string {
  appKey ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  return appKey;
}

/** A v2 session token's active Organization claim, as Clerk writes it: `rol` without the `org:` prefix. */
export function activeOrganization(id: string, role: "admin" | "member" = "member") {
  return { v: 2, o: { id, rol: role, slg: "test-team" } };
}

/**
 * A session token shaped like Clerk's, signed with `key`. `expiresIn` is seconds from now; negative is past.
 * `claims` adds to the payload, such as `activeOrganization(...)`.
 */
export function sessionToken(
  key: CryptoKey,
  userId: string,
  expiresIn = 60,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (
    new SignJWT({ sid: "sess_test", azp: DASHBOARD_ORIGIN, ...claims })
      // `cat` is the category Clerk's SDK puts on a session token's header, and checks.
      .setProtectedHeader({ alg: "RS256", kid: "ins_test", typ: "JWT", cat: "cl_B7d4PD111AAA" })
      .setSubject(userId)
      .setIssuer(`https://${FRONTEND_API_HOST}`)
      .setIssuedAt(now - 120)
      .setNotBefore(now - 120)
      .setExpirationTime(now + expiresIn)
      .sign(key)
  );
}

/** A built dashboard's files in a throwaway folder. */
export function dashboardDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warden-dashboard-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Warden</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('warden');");
  return dir;
}

const healthy: HealthBody = { status: "ok", database: "ok", vector: "available" };

/** A Team that already exists, with these people in it at these Roles, written through `withTeam`. */
export async function seedTeam(
  withTeam: WithTeam,
  team: string,
  people: [userId: string, role: Role][],
) {
  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    for (const [user_id, role] of people) {
      await tx.insertInto("team_members").values({ team_id: team, user_id, role }).execute();
    }
  });
}

/** The Admin `newTeam` seeds by default, who links the installations `linkRepos` records. */
export const ADMIN = "user_admin";

/** A Team with an id no other case uses and these people in it (its Admin by default), written through `withTeam`. */
export async function newTeam(
  withTeam: WithTeam,
  people: [userId: string, role: Role][] = [[ADMIN, "admin"]],
) {
  const team = `org_${randomUUID()}`;
  await seedTeam(withTeam, team, people);
  return team;
}

/** The Team's hook_tokens rows, oldest first, read as that Team. */
export const hookTokenRows = (withTeam: WithTeam, team: string) =>
  withTeam(team, (tx) =>
    tx.$extendTables<HookTables>().selectFrom("hook_tokens").selectAll().orderBy("id").execute(),
  );

/** The time `minutes` minutes before now. */
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A GitHub repo's ref, as GitHub's `html_url` names it. */
export const repoRef = (name: string) => `https://github.com/example/${name}`;

/** An installation id no other case uses: GitHub's are positive integers. */
export const newInstallation = () => randomInt(1, 2 ** 47);

/** Links a new installation listing `refs` to the Team, and answers its id. */
export async function linkRepos(
  repoAssets: RepoAssets,
  team: string,
  refs: string[],
  linkedBy = ADMIN,
) {
  const installationId = newInstallation();
  await repoAssets.link(team, {
    installationId,
    linkedBy,
    repos: refs.map((ref, i) => ({ ref, githubId: i + 1 })),
  });
  return installationId;
}

/** Queues a Scan of `module` over `assets` for the Team, as its Admin's start does, and answers the stored Scan. */
export async function queueScan(scans: Scans, team: string, module: Module, assets: Asset[]) {
  const outcome = await scans.queue(team, {
    module,
    assets,
    rules: ["guard/secret-in-repo"],
    requestedBy: ADMIN,
  });
  if (outcome.kind !== "queued") throw new Error("the test's Scan was rate limited");
  return outcome.scan;
}

/**
 * Sets the Team's Scan `id` back to running since `minutes` minutes ago, queued a minute before that, as if its Job
 * moved it to running then and died. The schema keeps `queued_at` unwritable, so the row is set back in SQL.
 */
export async function setRunningSince(
  withTeam: WithTeam,
  team: string,
  id: string,
  minutes: number,
) {
  const started = minutesAgo(minutes);
  await withTeam(team, (tx) =>
    sql`update scan_requests set state = 'running', started_at = ${started},
          queued_at = ${started}::timestamptz - interval '1 minute'
        where id = ${id}`.execute(tx),
  );
}

/**
 * A request to `app` as `as`, signed in to Team `teamId` with a session token signed by `key`: `body` sent as JSON,
 * or as it is when it's already a string. Its status, Retry-After, body read as JSON (undefined when empty) and text.
 */
export async function call(
  app: Hono<AppEnv>,
  key: CryptoKey,
  method: string,
  path: string,
  { as, teamId, body }: { as: string; teamId: string; body?: unknown },
) {
  const token = await sessionToken(key, as, 60, activeOrganization(teamId));
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    retryAfter: res.headers.get("Retry-After"),
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
}

/**
 * A Product of `team`'s put straight into the Products tables through `withTeam`, as the store reads them, with no
 * Repo URLs and no dependencies unless given. Returns its id.
 */
export async function seedProduct(
  withTeam: WithTeam,
  team: string,
  { name, repo_urls = [], dependencies = [] }: Partial<ProductInput> & { name: string },
): Promise<string> {
  const id = randomUUID();
  await withTeam(team, async (tx) => {
    await tx.insertInto("products").values({ team_id: team, id, name, repo_urls }).execute();
    for (const dependency of dependencies) {
      await tx
        .insertInto("product_dependencies")
        .values({ team_id: team, product_id: id, ...dependency })
        .execute();
    }
  });
  return id;
}

/** What a test Patch Finding is built from: its CVE, package and version, and any field it sets otherwise. */
export type PatchFindingFields = { cve: string; pkg?: string; version?: string } & Partial<Finding>;

/**
 * An Open `patch/known-vulnerability` Finding for `cve` on Product `productId` of `team`, as a Scan before this one
 * would have left it, with any other field `overrides` set. Built only: nothing is written.
 */
export function patchFinding(
  team: string,
  productId: string,
  { cve, pkg = "pkg:pypi/langchain", version = "0.0.200", ...overrides }: PatchFindingFields,
): Finding {
  const location = { kind: "dependency", package: pkg, version, vulnerability: cve } as const;
  return {
    id: randomUUID(),
    team,
    asset: { kind: "product", ref: productId },
    module: "patch",
    rule_id: PATCH_RULE,
    fingerprint: fingerprint(PATCH_RULE, location),
    location,
    severity: "high",
    title: `${cve}: a known vulnerability`,
    evidence: { summary: `Version ${version} is affected.` },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...overrides,
  };
}

/**
 * `patchFinding`'s Finding, written straight into `findings` through `withTeam`: no Scan runs, so the Product needn't
 * exist. Returns it.
 */
export async function seedPatchFinding(
  withTeam: WithTeam,
  team: string,
  productId: string,
  fields: PatchFindingFields,
): Promise<Finding> {
  const finding = patchFinding(team, productId, fields);
  await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(finding)).execute());
  return finding;
}

/** Members and Findings for a test that never reaches the database: any call fails it. */
const noDatabase = () => Promise.reject(new Error("this test app has no database: pass withTeam"));
const noMembers: Members = { open: noDatabase, list: noDatabase, changeRole: noDatabase };
const noFindings: Findings = {
  reconcile: noDatabase,
  report: noDatabase,
  scan: noDatabase,
  scanLocked: noDatabase,
  list: noDatabase,
  assetRefs: noDatabase,
  history: noDatabase,
  overview: noDatabase,
  accept: noDatabase,
  markFalsePositive: noDatabase,
  confirmFix: noDatabase,
  markMoved: noDatabase,
  reopen: noDatabase,
  propose: noDatabase,
  approveProposal: noDatabase,
  rejectProposal: noDatabase,
  pendingProposals: noDatabase,
  expireAcceptances: noDatabase,
};

const noScans: Scans = {
  queue: noDatabase,
  get: noDatabase,
  lastFor: noDatabase,
  move: noDatabase,
};

/** A Clerk seam for a test that doesn't look at Clerk: every call is refused (a Role change answers 502; a join logs it). */
const noClerk: ClerkOrganizations = {
  setMembershipRole: () =>
    Promise.reject(new Error("this test app has no Clerk: pass clerkOrganizations")),
};

/**
 * The app with a real Clerk verifier over `publicPem`, and the log lines it writes. With `withTeam`, the real members
 * module on it, calling `clerkOrganizations` (a fake) to keep Clerk's org:admin in step, and the real Findings module
 * with Guard's and Patch's move rules, as the start-up file wires them. It runs as on Cloud Run, so
 * a test picks the client's address with an X-Forwarded-For header. `mount` adds throwaway routes, behind the app's
 * own middleware.
 */
export function testApp(options: {
  publicPem: string;
  checkHealth?: () => Promise<HealthBody>;
  withTeam?: WithTeam;
  clerkOrganizations?: ClerkOrganizations;
  /** How long the members module waits for Clerk; short in a test of Clerk not answering. */
  clerkTimeoutMs?: number;
  mount?: MountRoutes;
  /** Each module's scanner for `POST /api/scans`; none by default, as index.ts wires them in this slice. */
  scanners?: Scanners;
  /** The Scan Job starter; none by default, so a start answers 503. */
  startScanJob?: ScanJobStarter;
  /** The queued Scans, in place of the real ones on `withTeam`. */
  scans?: Scans;
  /** Each module's routes, such as Guard's; none by default. */
  moduleRoutes?: MountRoutes[];
  /** Each module's check of a start's Assets; none by default, so any Assets the body's shape allows are queued. */
  assetChecks?: AssetChecks;
}) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const app = createApp(
    {
      logger,
      verifySessionToken: createClerkVerifier({
        secretKey: "unused-in-tests",
        jwtKey: options.publicPem,
        authorizedParties: [DASHBOARD_ORIGIN],
      }),
      members: options.withTeam
        ? createMembers({
            withTeam: options.withTeam,
            clerkOrganizations: options.clerkOrganizations ?? noClerk,
            logger,
            clerkTimeoutMs: options.clerkTimeoutMs,
          })
        : noMembers,
      findings: options.withTeam
        ? createFindings({ withTeam: options.withTeam, moveRules: MOVE_RULES })
        : noFindings,
      scans:
        options.scans ?? (options.withTeam ? createScans({ withTeam: options.withTeam }) : noScans),
      scanners: options.scanners ?? {},
      startScanJob: options.startScanJob,
      moduleRoutes: options.moduleRoutes ?? [],
      assetChecks: options.assetChecks ?? {},
      behindCloudRun: true,
      checkHealth: options.checkHealth ?? (async () => healthy),
      frontendApiHost: FRONTEND_API_HOST,
      dashboardDir: dashboardDir(),
    },
    options.mount,
  );
  return { app, lines };
}

/** The log lines in `output` (a process's output, or a logger's lines joined), parsed. */
export function logEntries(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

/** The error `promise` rejects with; a promise that resolves fails the test. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the promise resolved");
}

/** What `promise` was refused with: its class's name and its words (undefined when it resolved). */
export async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof Error ? { name: error.name, message: error.message } : error;
}
