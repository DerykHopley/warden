// Test seams: a key pair standing in for a Clerk instance, and an app wired as production wires it.
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { HealthBody, Role } from "@warden/contracts";
import { createApp, type MountRoutes } from "../src/app.ts";
import { createClerkVerifier } from "../src/auth.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { createMembers, type ClerkOrganizations, type Members } from "../src/members.ts";
import { guardMoveRule } from "../src/modules/guard/move-rule.ts";
import type { RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { patchMoveRule } from "../src/modules/patch/move-rule.ts";
import {
  createScans,
  type AssetChecks,
  type ScanJobStarter,
  type Scanners,
  type Scans,
} from "../src/scans.ts";
import type { WithTeam } from "../src/with-team.ts";

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

/** Members and Findings for a test that never reaches the database: any call fails it. */
const noDatabase = () => Promise.reject(new Error("this test app has no database: pass withTeam"));
const noMembers: Members = { open: noDatabase, list: noDatabase, changeRole: noDatabase };
const noFindings: Findings = {
  reconcile: noDatabase,
  report: noDatabase,
  scan: noDatabase,
  list: noDatabase,
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

const noScans: Scans = { queue: noDatabase, get: noDatabase, move: noDatabase };

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
        ? createFindings({
            withTeam: options.withTeam,
            moveRules: { guard: guardMoveRule, patch: patchMoveRule },
          })
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
