// Stories 3 and 4 end to end: a Lead starts a Guard Scan of a linked repo (`POST /api/scans`), the Scan Job runs in
// process with Guard's scanner as the wiring builds it over a fake RepoReader, and `GET /api/findings` shows what it
// found; the next Scan, with the secrets gone, marks them Fixed. Through the real app on the suite's shared database,
// each case with a Team of its own. The planted secrets are joined from parts, so the source never holds a whole one.
import { randomUUID } from "node:crypto";
import { FindingsBody, type Asset } from "@warden/contracts";
import type { CryptoKey } from "jose";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import { packRule } from "../src/modules/guard/default-pack.ts";
import { createRepoAssets, guardAssetCheck } from "../src/modules/guard/repo-assets.ts";
import type { RepoFile, RepoReader } from "../src/modules/guard/repo-reader.ts";
import { runScanJob } from "../src/scan-job.ts";
import { createScans, type ScanJobStarter } from "../src/scans.ts";
import { MOVE_RULES, scanners } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { AWS_KEY, GITHUB_TOKEN } from "./secret-fixtures.ts";
import {
  activeOrganization,
  linkRepos,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
});

afterAll(async () => {
  await pool.end();
});

const LEAD = "user_lead";
const repo: Asset = { kind: "repo", ref: "https://github.com/example/guarded" };

const planted: RepoFile[] = [
  { path: "README.md", text: "# Guarded\n" },
  { path: "src/config.ts", text: `// settings\n\nexport const awsKey = "${AWS_KEY}";\n` },
  {
    path: ".claude/settings.local.json",
    text: `{\n  "env": {\n    "GITHUB_TOKEN": "${GITHUB_TOKEN}"\n  }\n}\n`,
  },
];
const removed: RepoFile[] = [
  { path: "README.md", text: "# Guarded\n" },
  { path: "src/config.ts", text: "export const awsKey = process.env.AWS_KEY;\n" },
  { path: ".claude/settings.local.json", text: '{\n  "env": {}\n}\n' },
];

/**
 * The app wired as index.ts wires it, except that its starter runs the Scan Job in process, as scan-job.ts wires it,
 * with Guard's scanner given `read` as its RepoReader. Each Job's promise is kept to await, and every log line too.
 */
function guardApp(read: () => AsyncIterable<RepoFile>) {
  const jobLines: string[] = [];
  const logger = createLogger((line) => jobLines.push(line));
  const reader: RepoReader = { readRepo: () => read() };
  const repoAssets = createRepoAssets({ withTeam });
  const jobs: Promise<0 | 1>[] = [];
  const startScanJob: ScanJobStarter = async ({ scanId, team }) => {
    jobs.push(
      runScanJob({
        scanId,
        team,
        scans: createScans({ withTeam }),
        findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
        scanners: scanners({ withTeam, reader, logger }),
        logger,
      }),
    );
  };
  const { app, lines } = testApp({
    publicPem,
    withTeam,
    scanners: scanners({ withTeam, logger }),
    assetChecks: { guard: guardAssetCheck(repoAssets) },
    startScanJob,
  });
  return { app, repoAssets, jobs, logLines: () => [...lines, ...jobLines] };
}

type GuardApp = ReturnType<typeof guardApp>;

async function newTeam() {
  const team = `org_guardscan_${randomUUID()}`;
  await seedTeam(withTeam, team, [[LEAD, "lead"]]);
  return team;
}

async function headers(team: string) {
  const token = await sessionToken(key, LEAD, 60, activeOrganization(team));
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Starts a Guard Scan of the repo as the Lead, and answers the Job's exit code once it has run. */
async function scanRepo({ app, jobs }: GuardApp, team: string) {
  const res = await app.request("/api/scans", {
    method: "POST",
    headers: await headers(team),
    body: JSON.stringify({ module: "guard", assets: [repo] }),
  });
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  return { id, exit: await jobs.at(-1) };
}

async function listFindings({ app }: GuardApp, team: string) {
  const res = await app.request("/api/findings", { headers: await headers(team) });
  expect(res.status).toBe(200);
  return FindingsBody.parse(await res.json()).findings;
}

const files = (list: RepoFile[]) =>
  async function* () {
    yield* list;
  };

describe("a Guard Scan of a linked repo (stories 3, 4)", () => {
  it("opens a Finding per secret Rule with masked evidence and the fix, then marks both Fixed once removed", async () => {
    const team = await newTeam();
    let current = planted;
    const guard = guardApp(() => files(current)());
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);

    const first = await scanRepo(guard, team);

    expect(first.exit).toBe(0);
    const opened = await listFindings(guard, team);
    expect(opened).toHaveLength(2);
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          asset: repo,
          rule_id: "guard/secret-in-repo",
          status: "open",
          severity: "high",
          location: { kind: "file", path: "src/config.ts", line: 3 },
          evidence: {
            summary: `1 secret (AWS access key id) in src/config.ts, on line 3. To fix: ${packRule("guard/secret-in-repo").fix}`,
            secret: {
              type: "AWS access key id",
              path: "src/config.ts",
              line: 3,
              mask: "AKIA********",
            },
          },
        }),
        expect.objectContaining({
          asset: repo,
          rule_id: "guard/secret-in-agent-settings",
          status: "open",
          severity: "high",
          location: { kind: "file", path: ".claude/settings.local.json", line: 3 },
          evidence: {
            summary: `1 secret (GitHub token) in .claude/settings.local.json, on line 3. To fix: ${packRule("guard/secret-in-agent-settings").fix}`,
            secret: {
              type: "GitHub token",
              path: ".claude/settings.local.json",
              line: 3,
              mask: "ghp_********",
            },
          },
        }),
      ]),
    );

    current = removed;
    const second = await scanRepo(guard, team);

    expect(second.exit).toBe(0);
    const after = await listFindings(guard, team);
    expect(after.map(({ id, status }) => ({ id, status }))).toEqual(
      expect.arrayContaining(opened.map(({ id }) => ({ id, status: "fixed" }))),
    );
    expect(after).toHaveLength(2);
  });

  it("keeps the planted secrets out of every column of the Team's Findings, their history, its Scans and the log", async () => {
    const team = await newTeam();
    const guard = guardApp(files(planted));
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);

    expect((await scanRepo(guard, team)).exit).toBe(0);
    expect(await listFindings(guard, team)).toHaveLength(2);

    // Each row whole, read as text: every column, whatever its type.
    const stored = await withTeam(team, async (tx) => {
      const tables = ["findings", "finding_history", "scan_requests", "scans", "scan_coverage"];
      const rows = await Promise.all(
        tables.map((table) =>
          sql<{ row: string }>`select t::text as row from ${sql.table(table)} t`.execute(tx),
        ),
      );
      return rows.flatMap((result) => result.rows.map(({ row }) => row));
    });
    expect(stored.some((row) => row.includes("AKIA********"))).toBe(true);
    for (const secret of [AWS_KEY, GITHUB_TOKEN]) {
      expect(stored.filter((row) => row.includes(secret))).toEqual([]);
      expect(guard.logLines().filter((line) => line.includes(secret))).toEqual([]);
    }
    expect(guard.logLines().join("")).toContain('"files":3');
  });

  it("fails a Scan whose repo the reader can't read, reconciling nothing and logging why", async () => {
    const team = await newTeam();
    let unreadable = false;
    const guard = guardApp(async function* () {
      yield planted[0]!;
      if (unreadable) throw new Error("the repo's archive is cut short");
      yield* planted.slice(1);
    });
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);
    expect((await scanRepo(guard, team)).exit).toBe(0);
    const before = await listFindings(guard, team);
    expect(before.map((finding) => finding.status)).toEqual(["open", "open"]);

    unreadable = true;
    const failed = await scanRepo(guard, team);

    expect(failed.exit).toBe(1);
    expect(await listFindings(guard, team)).toEqual(before);
    const scan = await createScans({ withTeam }).get(team, failed.id);
    expect(scan).toMatchObject({ state: "failed" });
    expect(
      guard.logLines().map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        scanId: failed.id,
        error: expect.objectContaining({ message: "the repo's archive is cut short" }),
      }),
    );
  });
});
