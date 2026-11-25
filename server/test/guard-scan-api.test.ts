// Stories 3 and 4 end to end: a Lead starts a Guard Scan of a linked repo (`POST /api/scans`), the Scan Job runs in
// process with Guard's scanner as the wiring builds it over a fake RepoReader, and `GET /api/findings` shows what it
// found; the next Scan, with the secrets gone, marks them Fixed. Two cases read the repo through the GitHub reader on
// a fake fetch serving built tarballs, so the whole path from GitHub's HTTP boundary is covered. Through the real app
// on the suite's shared database, each case with a Team of its own. The planted secrets are joined from parts, so the
// source never holds a whole one.
import { randomUUID } from "node:crypto";
import { FindingsBody, type Asset } from "@warden/contracts";
import type { CryptoKey } from "jose";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings } from "../src/findings/index.ts";
import type { Fetch } from "../src/http-call.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { packRule } from "../src/modules/guard/default-pack.ts";
import { createRepoAssets, guardAssetCheck } from "../src/modules/guard/repo-assets.ts";
import type { RepoFile, RepoReader, UnreadFile } from "../src/modules/guard/repo-reader.ts";
import { runScanJob } from "../src/scan-job.ts";
import { createScans, type ScanJobStarter } from "../src/scans.ts";
import { gitHubRepoReader, MOVE_RULES, scanners } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { AWS_KEY, GITHUB_TOKEN } from "./secret-fixtures.ts";
import { chunks, tarballOf, type RepoLink } from "./tarballs.ts";
import {
  activeOrganization,
  gitHubAppKey,
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

/**
 * The repo's root agent config: it denies reads of .env and runs a guard hook before each tool call, so the repo,
 * which uses Claude Code, gets neither whole-repo agent-config Finding.
 */
const guarded: RepoFile = {
  path: ".claude/settings.json",
  text: `${JSON.stringify(
    {
      permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: ".claude/hooks/guard.sh" }] },
        ],
      },
    },
    null,
    2,
  )}\n`,
};

const planted: RepoFile[] = [
  { path: "README.md", text: "# Guarded\n" },
  { path: "src/config.ts", text: `// settings\n\nexport const awsKey = "${AWS_KEY}";\n` },
  {
    path: ".claude/settings.local.json",
    text: `{\n  "env": {\n    "GITHUB_TOKEN": "${GITHUB_TOKEN}"\n  }\n}\n`,
  },
  guarded,
];
const removed: RepoFile[] = [
  { path: "README.md", text: "# Guarded\n" },
  { path: "src/config.ts", text: "export const awsKey = process.env.AWS_KEY;\n" },
  { path: ".claude/settings.local.json", text: '{\n  "env": {}\n}\n' },
  guarded,
];

/** A RepoReader that yields what `read` does for any repo. */
const readerOf = (read: () => AsyncIterable<RepoFile | UnreadFile>) => (): RepoReader => ({
  readRepo: () => read(),
});

/**
 * The app wired as index.ts wires it, except that its starter runs the Scan Job in process, as scan-job.ts wires it,
 * with Guard's scanner given the RepoReader `makeReader` builds over the Job's logger. Each Job's promise is kept to
 * await, and every log line too.
 */
function guardApp(makeReader: (logger: Logger) => RepoReader) {
  const jobLines: string[] = [];
  const logger = createLogger((line) => jobLines.push(line));
  const reader = makeReader(logger);
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

const files = (list: (RepoFile | UnreadFile)[]) =>
  async function* () {
    yield* list;
  };

/**
 * Each row of the Team's Findings, their history and its Scans, whole and read as text: every column, whatever its
 * type.
 */
async function storedRows(team: string) {
  return withTeam(team, async (tx) => {
    const tables = ["findings", "finding_history", "scan_requests", "scans", "scan_coverage"];
    const rows = await Promise.all(
      tables.map((table) =>
        sql<{ row: string }>`select t::text as row from ${sql.table(table)} t`.execute(tx),
      ),
    );
    return rows.flatMap((result) => result.rows.map(({ row }) => row));
  });
}

const INSTALLATION_TOKEN = "ghs_the-fake-installation-token";

/**
 * GitHub at its HTTP boundary (spec decision 11): an installation token for any installation, and the repo's tarball,
 * built from `served()`, for a call carrying that token. fetch follows GitHub's redirect to the download itself, so the
 * fake answers the tarball call with the archive. Anything else, a tarball call without the token included, is a 404.
 */
function fakeGitHubFetch(served: () => (RepoFile | RepoLink)[]) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (
      method === "POST" &&
      /^https:\/\/api\.github\.com\/app\/installations\/\d+\/access_tokens$/.test(url)
    ) {
      return Response.json(
        { token: INSTALLATION_TOKEN, expires_at: "2026-11-25T13:00:00Z" },
        { status: 201 },
      );
    }
    if (
      method === "GET" &&
      url === "https://api.github.com/repos/example/guarded/tarball" &&
      new Headers(init.headers).get("Authorization") === `Bearer ${INSTALLATION_TOKEN}`
    ) {
      return new Response(ReadableStream.from(chunks(tarballOf(served()), 512)), {
        status: 200,
        headers: { "Content-Type": "application/x-gzip" },
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { fetch, calls };
}

/** The app, its Scan Job reading the repo through the GitHub reader from fake GitHub serving `served()`. */
function gitHubGuardApp(served: () => (RepoFile | RepoLink)[]) {
  const github = fakeGitHubFetch(served);
  const guard = guardApp((logger) =>
    gitHubRepoReader(
      { clientId: "Iv23li-the-client-id", privateKey: gitHubAppKey() },
      logger,
      github.fetch,
    ),
  );
  return { github, guard };
}

describe("a Guard Scan of a linked repo (stories 3, 4)", () => {
  it("opens a Finding per secret Rule with masked evidence and the fix, then marks both Fixed once removed", async () => {
    const team = await newTeam();
    let current = planted;
    const guard = guardApp(readerOf(() => files(current)()));
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
    const guard = guardApp(readerOf(files(planted)));
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);

    expect((await scanRepo(guard, team)).exit).toBe(0);
    expect(await listFindings(guard, team)).toHaveLength(2);

    const stored = await storedRows(team);
    expect(stored.some((row) => row.includes("AKIA********"))).toBe(true);
    for (const secret of [AWS_KEY, GITHUB_TOKEN]) {
      expect(stored.filter((row) => row.includes(secret))).toEqual([]);
      expect(guard.logLines().filter((line) => line.includes(secret))).toEqual([]);
    }
    expect(guard.logLines().join("")).toContain('"files":4');
  });

  it("reads the repo through GitHub's HTTP boundary: opens both Findings, then marks them Fixed, with the token and the secrets in no log line and no table", async () => {
    const team = await newTeam();
    let current = planted;
    const { github, guard } = gitHubGuardApp(() => current);
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);

    expect((await scanRepo(guard, team)).exit).toBe(0);
    const opened = await listFindings(guard, team);
    expect(opened.map(({ rule_id, status }) => ({ rule_id, status }))).toEqual(
      expect.arrayContaining([
        { rule_id: "guard/secret-in-repo", status: "open" },
        { rule_id: "guard/secret-in-agent-settings", status: "open" },
      ]),
    );
    expect(opened).toHaveLength(2);

    current = removed;
    expect((await scanRepo(guard, team)).exit).toBe(0);
    const after = await listFindings(guard, team);
    expect(after.map(({ id, status }) => ({ id, status }))).toEqual(
      expect.arrayContaining(opened.map(({ id }) => ({ id, status: "fixed" }))),
    );
    expect(after).toHaveLength(2);

    // Each Scan asked for a token, then the tarball with it.
    expect(github.calls.filter((call) => call.endsWith("/tarball"))).toHaveLength(2);
    const stored = await storedRows(team);
    const logged = guard.logLines();
    expect(logged.join("")).toContain('"files":4');
    for (const secret of [INSTALLATION_TOKEN, AWS_KEY, GITHUB_TOKEN]) {
      expect(stored.filter((row) => row.includes(secret))).toEqual([]);
      expect(logged.filter((line) => line.includes(secret))).toEqual([]);
    }
  });

  it("keeps a secret's Finding Open, unchanged, once its file grows past the 1 MiB a Scan reads, and marks the removed one Fixed", async () => {
    const team = await newTeam();
    let current = planted;
    const { guard } = gitHubGuardApp(() => current);
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);
    expect((await scanRepo(guard, team)).exit).toBe(0);
    const opened = await listFindings(guard, team);
    const inConfig = opened.find((finding) => finding.rule_id === "guard/secret-in-repo")!;
    const inSettings = opened.find((finding) => finding.id !== inConfig.id)!;

    const config = planted[1]!;
    const grown = { path: config.path, text: `${config.text}// ${"x".repeat(1024 * 1024)}\n` };
    current = [removed[0]!, grown, removed[2]!, guarded];
    expect((await scanRepo(guard, team)).exit).toBe(0);

    const after = await listFindings(guard, team);
    expect(after).toEqual(
      expect.arrayContaining([
        inConfig,
        expect.objectContaining({ id: inSettings.id, status: "fixed" }),
      ]),
    );
    expect(after).toHaveLength(2);
  });

  it("opens a Finding for a broad Bash allow, one per file that skips permission checks, and the two whole-repo agent-config Rules, each with its fix (story 3)", async () => {
    const team = await newTeam();
    // Joined from parts, so this file never holds the flag or the mode for a Guard Scan of Warden to report.
    const flag = ["--dangerously", "-skip-permissions"].join("");
    const bypass = ["bypass", "Permissions"].join("");
    const agentConfig: RepoFile[] = [
      {
        path: "README.md",
        text: `# Guarded\n\nNever run \`claude ${flag}\` here.\n`,
      },
      {
        path: ".claude/settings.json",
        text: `{\n  "permissions": {\n    "allow": ["Bash(*)"],\n    "defaultMode": "${bypass}"\n  }\n}\n`,
      },
      {
        path: "scripts/agent.sh",
        text: `#!/bin/sh\nclaude ${flag} -p "$1"\n`,
      },
      // Last, so the whole-repo Rules see it only if they run after the repo's last file.
      { path: "CLAUDE.md", text: "# Guarded\n\nRun the tests before each commit.\n" },
    ];
    const guard = guardApp(readerOf(files(agentConfig)));
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);

    expect((await scanRepo(guard, team)).exit).toBe(0);

    const opened = await listFindings(guard, team);
    const blanket = packRule("guard/blanket-bash-allow");
    const skip = packRule("guard/permission-skip");
    const readEnv = packRule("guard/agent-can-read-env");
    const noGuard = packRule("guard/no-runtime-guard");
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          asset: repo,
          rule_id: readEnv.ruleId,
          status: "open",
          severity: "high",
          title: readEnv.title,
          location: { kind: "file", path: ".claude/settings.json" },
          evidence: {
            summary: `No permissions.deny rule in .claude/settings.json or .claude/settings.local.json stops the agent reading .env. To fix: ${readEnv.fix}`,
          },
        }),
        expect.objectContaining({
          asset: repo,
          rule_id: noGuard.ruleId,
          status: "open",
          severity: "medium",
          title: noGuard.title,
          location: { kind: "file", path: ".claude/settings.json" },
          evidence: {
            summary: `Nothing checks the agent's tool calls: no permissions.deny rule and no PreToolUse hook in .claude/settings.json or .claude/settings.local.json. To fix: ${noGuard.fix}`,
          },
        }),
        expect.objectContaining({
          asset: repo,
          rule_id: blanket.ruleId,
          status: "open",
          severity: "high",
          title: blanket.title,
          location: { kind: "file", path: ".claude/settings.json", line: 3 },
          evidence: {
            summary: `1 broad Bash allow (Bash(*)) in .claude/settings.json, on line 3. To fix: ${blanket.fix}`,
          },
        }),
        expect.objectContaining({
          asset: repo,
          rule_id: skip.ruleId,
          status: "open",
          severity: "high",
          title: skip.title,
          location: { kind: "file", path: ".claude/settings.json", line: 4 },
          evidence: {
            summary: `1 place skips the agent's permission checks (defaultMode ${bypass} (applies before Claude Code v2.1.257)) in .claude/settings.json, on line 4. To fix: ${skip.fix}`,
          },
        }),
        expect.objectContaining({
          asset: repo,
          rule_id: skip.ruleId,
          status: "open",
          severity: "high",
          title: skip.title,
          location: { kind: "file", path: "scripts/agent.sh", line: 2 },
          evidence: {
            summary: `1 place skips the agent's permission checks (${flag}) in scripts/agent.sh, on line 2. To fix: ${skip.fix}`,
          },
        }),
      ]),
    );
    expect(opened).toHaveLength(5);
    expect(guard.logLines().join("")).toContain('"observations":5');
  });

  it("keeps the whole-repo Findings Open when a root settings file is unread, rather than marking them Fixed on a guess", async () => {
    const team = await newTeam();
    const claudeMd: RepoFile = { path: "CLAUDE.md", text: "# Guarded\n" };
    let current: (RepoFile | UnreadFile)[] = [claudeMd];
    const guard = guardApp(readerOf(() => files(current)()));
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);
    expect((await scanRepo(guard, team)).exit).toBe(0);
    const opened = await listFindings(guard, team);
    expect(opened.map(({ rule_id, status }) => ({ rule_id, status }))).toEqual(
      expect.arrayContaining([
        { rule_id: "guard/agent-can-read-env", status: "open" },
        { rule_id: "guard/no-runtime-guard", status: "open" },
      ]),
    );
    expect(opened).toHaveLength(2);

    // The root settings.json now guards the agent, but settings.local.json, which Claude Code merges with it, is unread.
    current = [claudeMd, guarded, { path: ".claude/settings.local.json", unread: true }];
    expect((await scanRepo(guard, team)).exit).toBe(0);

    expect(await listFindings(guard, team)).toEqual(opened);
  });

  it("opens no whole-repo Finding when the guarding root settings file becomes a symlink, which it doesn't follow (story 3)", async () => {
    const team = await newTeam();
    const claudeMd: RepoFile = { path: "CLAUDE.md", text: "# Guarded\n" };
    let current: (RepoFile | RepoLink)[] = [claudeMd, guarded];
    const { guard } = gitHubGuardApp(() => current);
    await linkRepos(guard.repoAssets, team, [repo.ref], LEAD);
    expect((await scanRepo(guard, team)).exit).toBe(0);
    expect(await listFindings(guard, team)).toEqual([]);

    // The settings now live elsewhere, read only through the link, which a Scan reports unread.
    current = [
      claudeMd,
      { path: "config/claude-settings.json", text: guarded.text },
      { path: ".claude/settings.json", link: "../config/claude-settings.json" },
    ];
    expect((await scanRepo(guard, team)).exit).toBe(0);

    expect(await listFindings(guard, team)).toEqual([]);
  });

  it("fails a Scan whose repo the reader can't read, reconciling nothing and logging why", async () => {
    const team = await newTeam();
    let unreadable = false;
    const guard = guardApp(
      readerOf(async function* () {
        yield planted[0]!;
        if (unreadable) throw new Error("the repo's archive is cut short");
        yield* planted.slice(1);
      }),
    );
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
