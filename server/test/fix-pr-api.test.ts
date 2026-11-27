// Story 6 at the API (#224, slice 2c), with story 5's Fix PR half and story 15's Fix PR cases: a person in the Team opens
// a Fix PR from a Finding through the write app (`POST /api/guard/findings/:id/fix-pr`), as a new branch, one commit
// and a PR into the default branch, never a write to it; a second click answers the same PR, an installation gone
// writes `revoked`, and a Fix PR opens only on one of the Team's own Repo Assets. `GET` on the same path answers whether
// the Finding is fixable and its newest Fix PR. Through the real app with the real routes, GitHub writer, Fix PRs store
// and write grants, GitHub and the npm registry faked at `fetch`, on the suite's shared database.
import { randomUUID } from "node:crypto";
import {
  FindingFixPrBody,
  fingerprint,
  FixPrBody,
  WriteGrantsBody,
  type Finding,
  type RuleId,
} from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import type { Fetch } from "../src/http-call.ts";
import { createLogger } from "../src/log.ts";
import { fixPrRoutes, FIX_PRS_PER_HOUR } from "../src/modules/guard/fix-pr-routes.ts";
import { createFixPrs, type FixPrs } from "../src/modules/guard/fix-prs.ts";
import { createGitHubWriter } from "../src/modules/guard/github-writer.ts";
import { createPackageRegistry } from "../src/modules/guard/package-registry.ts";
import { createRepoAssets, type RepoAssets } from "../src/modules/guard/repo-assets.ts";
import { writeGrantRoutes } from "../src/modules/guard/write-grant-routes.ts";
import { createWriteGrants, type WriteGrants } from "../src/modules/guard/write-grants.ts";
import { MOVE_RULES } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  logEntries,
  newInstallation,
  newTeam,
  patchFinding,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let repoAssets: RepoAssets;
let writeGrants: WriteGrants;
let fixPrs: FixPrs;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: MOVE_RULES });
  repoAssets = createRepoAssets({ withTeam });
  writeGrants = createWriteGrants({ withTeam });
  fixPrs = createFixPrs({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

const API = "https://api.github.com";
const WRITE_CLIENT_ID = "Iv23li-the-write-client-id";
const WRITE_APP = { contents: "write", pull_requests: "write", metadata: "read" };
const OWNER = "example";
const NAME = "web";
const FULL_NAME = `${OWNER}/${NAME}`;
const REF = `https://github.com/${FULL_NAME}`;
const DEFAULT_BRANCH = "main";
const HEAD_SHA = "a".repeat(40);
const SETTINGS = ".claude/settings.json";

const LEAD = "user_lead";
const MEMBER = "user_member";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fromBase64 = (text: string) => Buffer.from(text, "base64").toString("utf8");

type Call = { method: string; url: URL; body: Record<string, unknown> | undefined };
/**
 * A PR the fake holds: `author` is its opener's login, and `commits` each of its commits' author login, null for one
 * whose email GitHub links to no account.
 */
type Pull = {
  number: number;
  head: string;
  base: string;
  state: "open" | "closed";
  author: string;
  commits: (string | null)[];
};

/** The one request a fake answers 500 to, once. */
type FailAt = "repo" | "pull" | "commits" | "npm";

/** The write app's slug, as the fake's `GET /app` answers it, and the bot login its PRs and commits carry. */
const WRITE_SLUG = "warden-writer";
const BOT = `${WRITE_SLUG}[bot]`;
/** A person with push access to the repo but no seat in the Team. */
const PUSHER = "mallory";

/** A PR the write app's bot opened from `head` into `base`, holding its one commit. */
const botPull = (
  number: number,
  head: string,
  base = DEFAULT_BRANCH,
  state: Pull["state"] = "open",
): Pull => ({ number, head, base, state, author: BOT, commits: [BOT] });

/**
 * A fake GitHub holding one repo, `example/web` with GitHub id `repoId` and default branch `main`, and the npm registry.
 * Each installation in `installations` answers its token request with `status` (201 by default) and `permissions`
 * (the write app's by default); its token is `ghs_fix-<installation id>`. `files` are the files at the default
 * branch's head `HEAD_SHA`; `pushed`, when given, the default branch's files after a push since that head, which a read
 * by the branch's name answers. `branches` are the branches beside it, and a branch whose name a branch's path takes
 * (`warden` beside `warden/fix-…`) is refused with 422, as Git refuses it; `pulls` are its PRs, each one the PR create
 * opens being the write app's bot's with its one commit. `GET /app` answers the write app's slug, `WRITE_SLUG`.
 * `failAt` names one request that answers 500 once. `beforePut` holds each contents write until it settles, and
 * `onPullLookup` runs on each read of the open PRs from a branch. Every request is recorded, and every token and JWT
 * it was sent.
 */
function fakeGitHub({
  repoId,
  installations,
  files = {},
  pushed,
  npm = {},
  failAt,
  beforePut,
  onPullLookup,
}: {
  repoId: number;
  installations: Record<number, { status?: number; permissions?: Record<string, string> }>;
  files?: Record<string, string>;
  pushed?: Record<string, string>;
  npm?: Record<string, string>;
  failAt?: FailAt;
  beforePut?: () => Promise<void>;
  onPullLookup?: () => void;
}) {
  const calls: Call[] = [];
  const secrets = new Set<string>();
  const branches = new Set<string>();
  const pulls: Pull[] = [];
  const failing = new Set(failAt === undefined ? [] : [failAt]);
  const fail = (at: FailAt) => failing.delete(at);
  const repo = `${API}/repos/${FULL_NAME}`;
  const pullBody = (pull: Pull) => ({
    number: pull.number,
    html_url: `https://github.com/${FULL_NAME}/pull/${pull.number}`,
    state: pull.state,
    user: { login: pull.author, type: pull.author.endsWith("[bot]") ? "Bot" : "User" },
    head: { ref: pull.head },
    base: { ref: pull.base },
  });

  const fetch: Fetch = async (raw, init) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url, body });
    const auth = new Headers(init.headers).get("Authorization");
    if (auth?.startsWith("Bearer ")) secrets.add(auth.slice("Bearer ".length));
    const path = decodeURIComponent(url.pathname);
    const route = `${method} ${url.origin}${path}`;

    if (url.origin === "https://registry.npmjs.org") {
      if (fail("npm")) return json({ error: "down" }, 500);
      const name = path.slice(1).replace(/\/latest$/, "");
      const version = npm[name];
      return version === undefined ? json({}, 404) : json({ name, version });
    }

    const token =
      /^POST https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(route);
    if (token) {
      const id = Number(token[1]);
      const installation = installations[id];
      if (installation === undefined) return json({ message: "Not Found" }, 404);
      const status = installation.status ?? 201;
      if (status !== 201) return json({ message: "refused" }, status);
      const issued = `ghs_fix-${id}`;
      secrets.add(issued);
      return json({ token: issued, permissions: installation.permissions ?? WRITE_APP }, 201);
    }
    if (route === `GET ${API}/app`) {
      return json({ id: 7, slug: WRITE_SLUG, name: "Warden writer" });
    }
    if (route === `GET ${API}/repositories/${repoId}`) {
      if (fail("repo")) return json({ message: "Server Error" }, 500);
      return json({ id: repoId, full_name: FULL_NAME, default_branch: DEFAULT_BRANCH });
    }
    if (route.startsWith(`GET ${repo}/git/ref/heads/`)) {
      const branch = path.slice(`/repos/${FULL_NAME}/git/ref/heads/`.length);
      if (branch !== DEFAULT_BRANCH && !branches.has(branch))
        return json({ message: "Not Found" }, 404);
      return json({ ref: `refs/heads/${branch}`, object: { sha: HEAD_SHA, type: "commit" } });
    }
    if (route === `POST ${repo}/git/refs`) {
      const branch = String(body?.ref).replace(/^refs\/heads\//, "");
      if (branch === DEFAULT_BRANCH || branches.has(branch)) {
        return json({ message: "Reference already exists" }, 422);
      }
      const inTheWay = (other: string) =>
        branch.startsWith(`${other}/`) || other.startsWith(`${branch}/`);
      if ([DEFAULT_BRANCH, ...branches].some(inTheWay)) {
        return json({ message: "Reference update failed" }, 422);
      }
      branches.add(branch);
      return json({ ref: body?.ref, object: { sha: body?.sha, type: "commit" } }, 201);
    }
    if (route.startsWith(`GET ${repo}/contents/`)) {
      const file = path.slice(`/repos/${FULL_NAME}/contents/`.length);
      const ref = url.searchParams.get("ref");
      const [text, sha] =
        ref === HEAD_SHA
          ? [files[file], "b".repeat(40)]
          : ref === DEFAULT_BRANCH
            ? [(pushed ?? files)[file], (pushed ? "e" : "b").repeat(40)]
            : [undefined, ""];
      if (text === undefined) return json({ message: "Not Found" }, 404);
      return json({ type: "file", path: file, encoding: "base64", content: base64(text), sha });
    }
    if (route.startsWith(`PUT ${repo}/contents/`)) {
      await beforePut?.();
      return json({ content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } }, 201);
    }
    if (route === `POST ${repo}/pulls`) {
      if (fail("pull")) return json({ message: "Server Error" }, 500);
      const pull = botPull(pulls.length + 1, String(body?.head), String(body?.base));
      pulls.push(pull);
      return json(pullBody(pull), 201);
    }
    if (route === `GET ${repo}/pulls`) {
      onPullLookup?.();
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state");
      return json(
        pulls
          .filter(
            (pull) => `${OWNER}:${pull.head}` === head && (state === null || pull.state === state),
          )
          .map(pullBody),
      );
    }
    const one = new RegExp(`^GET ${repo.replace(/[.]/g, "\\.")}/pulls/(\\d+)(/commits)?$`).exec(
      route,
    );
    if (one) {
      const pull = pulls.find((p) => p.number === Number(one[1]));
      if (pull === undefined) return json({ message: "Not Found" }, 404);
      if (one[2] === undefined) return json(pullBody(pull));
      if (fail("commits")) return json({ message: "Server Error" }, 500);
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      // GitHub answers an author it links to no account as an empty object.
      return json(
        pull.commits.slice(0, perPage).map((login, i) => ({
          sha: String(i).repeat(40),
          author: login === null ? {} : { login },
          commit: { message: "A commit" },
        })),
      );
    }
    throw new Error(`unexpected call to ${route}`);
  };

  return {
    fetch,
    calls,
    secrets,
    branches,
    pulls,
    /** The requests that write: a ref, a contents write, a PR, a merge. */
    writes: () =>
      calls.filter(
        (call) => call.method !== "GET" && !call.url.pathname.endsWith("/access_tokens"),
      ),
    /** The requests to GitHub's API, the registry's left out. */
    gitHub: () => calls.filter((call) => call.url.origin === API),
  };
}

type Fake = ReturnType<typeof fakeGitHub>;

/** Each fake, answer text and log made in the running case, checked after it. */
let fakes: Fake[] = [];
let answers: string[] = [];
let logs: (() => string[])[] = [];

afterEach(() => {
  // No request in any case writes to the default branch: no ref made, moved or deleted on it, no contents write
  // naming it (or naming no branch), and no merge.
  for (const fake of fakes) {
    for (const call of fake.calls) {
      const where = `${call.method} ${call.url.pathname}`;
      expect(where).not.toMatch(/merge/);
      if (call.url.pathname.includes("/git/refs")) {
        expect(call.method, where).toBe("POST");
        expect(call.body?.ref, where).not.toBe(`refs/heads/${DEFAULT_BRANCH}`);
      }
      if (call.method === "PUT" && call.url.pathname.includes("/contents/")) {
        expect(call.body?.branch, where).toEqual(expect.stringMatching(/^warden\/fix-/));
      }
      if (call.method === "PATCH" || call.method === "DELETE") throw new Error(`${where} was sent`);
    }
    // No answer and no log line holds a token or the app's JWT.
    const said = [...answers, ...logs.flatMap((lines) => lines())].join("\n");
    for (const secret of fake.secrets) expect(said).not.toContain(secret);
  }
  fakes = [];
  answers = [];
  logs = [];
});

/**
 * The app with the Fix PR route over `fake` (none: the write app isn't set up), and the write grant's routes. The
 * route's wait between looks for an open PR is `pullWait`, none by default, so a case doesn't sleep.
 */
function fixApp(fake?: Fake, { pullWait = () => Promise.resolve() } = {}) {
  const routeLines: string[] = [];
  const logger = createLogger((line) => routeLines.push(line));
  const stores = { findings, repoAssets, writeGrants, fixPrs };
  if (fake) fakes.push(fake);
  const routes = [
    fake
      ? fixPrRoutes({
          ...stores,
          writer: createGitHubWriter({
            clientId: WRITE_CLIENT_ID,
            privateKey: gitHubAppKey(),
            fetch: fake.fetch,
          }),
          registry: createPackageRegistry({ fetch: fake.fetch }),
          logger,
          pullWait,
        })
      : fixPrRoutes(stores),
    writeGrantRoutes({ writeGrants }),
  ];
  const { app, lines } = testApp({ publicPem, withTeam, moduleRoutes: routes });
  const logLines = () => [...lines, ...routeLines];
  logs.push(logLines);
  return { app, logLines };
}

type App = ReturnType<typeof fixApp>["app"];

async function call(
  app: App,
  method: "GET" | "POST",
  team: string,
  path: string,
  { as = MEMBER, signedIn = true }: { as?: string; signedIn?: boolean } = {},
) {
  const headers: Record<string, string> = signedIn
    ? { Authorization: `Bearer ${await sessionToken(key, as, 60, activeOrganization(team))}` }
    : {};
  const res = await app.request(path, { method, headers });
  const text = await res.text();
  answers.push(text, JSON.stringify([...res.headers]));
  return {
    status: res.status,
    retryAfter: res.headers.get("Retry-After"),
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
  };
}

const fixPrPath = (id: string) => `/api/guard/findings/${encodeURIComponent(id)}/fix-pr`;
const post = (app: App, team: string, id: string, as?: string) =>
  call(app, "POST", team, fixPrPath(id), { as });
const get = (app: App, team: string, id: string) => call(app, "GET", team, fixPrPath(id));

const teamOfThree = () =>
  newTeam(withTeam, [
    [ADMIN, "admin"],
    [LEAD, "lead"],
    [MEMBER, "member"],
  ]);

/** A Guard Finding of `team`'s on `ref` at `path` under `rule`, written straight into `findings`. */
async function seedGuardFinding(
  team: string,
  {
    rule = "guard/agent-can-read-env",
    path = SETTINGS,
    ref = REF,
    ...overrides
  }: { rule?: RuleId; path?: string; ref?: string } & Partial<Finding> = {},
): Promise<Finding> {
  const location = { kind: "file", path } as const;
  const finding: Finding = {
    id: randomUUID(),
    team,
    asset: { kind: "repo", ref },
    module: "guard",
    rule_id: rule,
    fingerprint: fingerprint(rule, location),
    location,
    severity: "high",
    title: "A Guard Finding",
    evidence: { summary: `In ${path}.` },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...overrides,
  };
  await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(finding)).execute());
  return finding;
}

/**
 * A Team of three holding `example/web` as a Repo Asset (through a read installation of its own) and a write grant
 * for each of `granted` (one new installation by default), with an Open `agent-can-read-env` Finding on it unless
 * `finding` says otherwise. The repo's GitHub id, the grants and the Finding.
 */
async function fixableTeam({
  granted = [newInstallation()],
  finding,
}: { granted?: number[]; finding?: Parameters<typeof seedGuardFinding>[1] } = {}) {
  const team = await teamOfThree();
  const repoId = newInstallation();
  await repoAssets.link(team, {
    installationId: newInstallation(),
    linkedBy: ADMIN,
    repos: [{ ref: REF, githubId: repoId }],
  });
  for (const installationId of granted) {
    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
  }
  const seeded = await seedGuardFinding(team, finding);
  return { team, repoId, granted, finding: seeded };
}

/** The Team's `fix_prs` rows, read as that Team. */
const fixPrRows = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("fix_prs").selectAll().orderBy("id").execute());

/** The Team's `github_write_grants` rows of `event`, counted as that Team. */
const grantRows = (team: string, event: "granted" | "revoked") =>
  withTeam(team, (tx) =>
    tx.selectFrom("github_write_grants").selectAll().where("event", "=", event).execute(),
  );

const branchOf = (finding: Finding) => `warden/fix-${finding.id}`;

const installationsOf = (
  granted: number[],
  answers: Record<number, { status?: number; permissions?: Record<string, string> }> = {},
) => Object.fromEntries(granted.map((id) => [id, answers[id] ?? {}]));

describe("POST /api/guard/findings/:id/fix-pr: a person opens a Fix PR (story 6)", () => {
  it("opens a branch, one commit and a PR into the default branch, in that order, and answers 201 with it", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: { [SETTINGS]: '{\n  "permissions": {}\n}\n' },
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(201);
    const pr = FixPrBody.parse(res.body);
    expect(pr).toEqual({
      url: `https://github.com/${FULL_NAME}/pull/1`,
      number: 1,
      branch: branchOf(finding),
      opened_by: MEMBER,
      opened_at: expect.any(String),
    });

    const branch = branchOf(finding);
    const token = fake.calls.findIndex((c) => c.url.pathname.endsWith("/access_tokens"));
    const ref = fake.calls.findIndex((c) => c.url.pathname.endsWith("/git/refs"));
    const contents = fake.calls.findIndex((c) => c.method === "PUT");
    const pull = fake.calls.findIndex(
      (c) => c.method === "POST" && c.url.pathname.endsWith("/pulls"),
    );
    expect(token).toBeGreaterThanOrEqual(0);
    expect(fake.calls[token]?.body).toEqual({ repository_ids: [repoId] });
    expect(ref).toBeGreaterThan(token);
    expect(fake.calls[ref]?.body).toEqual({ ref: `refs/heads/${branch}`, sha: HEAD_SHA });
    expect(contents).toBeGreaterThan(ref);
    expect(fake.calls[contents]?.body).toMatchObject({ branch, sha: "b".repeat(40) });
    expect(JSON.parse(fromBase64(String(fake.calls[contents]?.body?.content)))).toEqual({
      permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] },
    });
    expect(pull).toBeGreaterThan(contents);
    expect(fake.calls[pull]?.body).toMatchObject({ head: branch, base: DEFAULT_BRANCH });
    expect(String(fake.calls[pull]?.body?.title)).toContain("The agent can read .env files");
    expect(String(fake.calls[pull]?.body?.body)).toContain(finding.id);
    expect(fake.writes()).toHaveLength(3);

    const read = await get(app, team, finding.id);
    expect(read.status).toBe(200);
    expect(FindingFixPrBody.parse(read.body)).toEqual({ fixable: true, fix_pr: pr });
  });

  it("answers 200 with the same PR on a second POST while it's open, making nothing new", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);
    const first = await post(app, team, finding.id);
    expect(first.status).toBe(201);
    const writes = fake.writes().length;

    const second = await post(app, team, finding.id);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fake.writes()).toHaveLength(writes);
    expect(await fixPrRows(team)).toHaveLength(1);
  });

  it("opens a new PR once the first is closed and its branch gone, and GET then answers the new one", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);
    expect((await post(app, team, finding.id)).status).toBe(201);
    for (const pull of fake.pulls) pull.state = "closed";
    fake.branches.clear();

    const again = await post(app, team, finding.id);

    expect(again.status).toBe(201);
    expect(FixPrBody.parse(again.body).number).toBe(2);
    const read = FindingFixPrBody.parse((await get(app, team, finding.id)).body);
    expect(read.fix_pr).toEqual(again.body);
  });

  it("answers 200 with the open PR whose head is the branch already there, and records it once", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    fake.branches.add(branchOf(finding));
    fake.pulls.push(botPull(9, branchOf(finding)));
    const { app } = fixApp(fake);

    const first = await post(app, team, finding.id);
    const second = await post(app, team, finding.id);

    expect(first.status).toBe(200);
    expect(FixPrBody.parse(first.body).number).toBe(9);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await fixPrRows(team)).toHaveLength(1);
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("answers 409 naming the branch when it's already there with no open PR, and writes no file or PR", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    fake.branches.add(branchOf(finding));
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 409,
      body: {
        error: `Branch ${branchOf(finding)} already exists on the repo with no open Fix PR from it; if one is being opened, try again in a minute, or else delete the branch to open a new Fix PR`,
      },
    });
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(fake.calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/pulls"))).toBe(
      false,
    );
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it("answers 409 for an open PR from the branch into another branch, and 200 for one into the default branch", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    fake.branches.add(branchOf(finding));
    fake.pulls.push(botPull(9, branchOf(finding), "develop"));
    const { app } = fixApp(fake);

    const intoDevelop = await post(app, team, finding.id);

    expect(intoDevelop.status).toBe(409);
    expect(JSON.stringify(intoDevelop.body)).toContain(branchOf(finding));
    expect(await fixPrRows(team)).toHaveLength(0);

    fake.pulls.push(botPull(10, branchOf(finding)));
    const intoMain = await post(app, team, finding.id);

    expect(intoMain.status).toBe(200);
    expect(FixPrBody.parse(intoMain.body).number).toBe(10);
    expect((await fixPrRows(team)).map((row) => row.number)).toEqual([10]);
  });

  it("answers the second of two clicks at once with the PR the first opens, never asking to delete its branch", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    // The first click's commit waits until the second has looked for an open PR and found none.
    let lookedUp = () => {};
    const looked = new Promise<void>((resolve) => (lookedUp = resolve));
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      beforePut: () => looked,
      onPullLookup: () => lookedUp(),
    });
    // The second click's wait between looks ends once the first click's PR is open, or after 1,000 turns.
    const pullWait = async () => {
      for (let turn = 0; turn < 1000 && fake.pulls.length === 0; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const { app } = fixApp(fake, { pullWait });

    const clicks = await Promise.all([post(app, team, finding.id), post(app, team, finding.id)]);

    expect(clicks.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(clicks[0]?.body).toEqual(clicks[1]?.body);
    expect(fake.pulls).toHaveLength(1);
    expect(await fixPrRows(team)).toHaveLength(1);
  });

  it("builds its edit on the file at the head the branch is made from, though the default branch moved since", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: { [SETTINGS]: '{\n  "permissions": {}\n}\n' },
      pushed: { [SETTINGS]: '{\n  "model": "pushed since",\n  "permissions": {}\n}\n' },
    });
    const { app } = fixApp(fake);

    expect((await post(app, team, finding.id)).status).toBe(201);

    const read = fake.calls.find(
      (c) => c.method === "GET" && c.url.pathname.includes("/contents/"),
    );
    expect(read?.url.searchParams.get("ref")).toBe(HEAD_SHA);
    const contents = fake.calls.find((c) => c.method === "PUT");
    expect(contents?.body?.sha).toBe("b".repeat(40));
    expect(JSON.parse(fromBase64(String(contents?.body?.content)))).toEqual({
      permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] },
    });
  });

  it("answers 409 naming the branch in the way when a branch named warden takes the Fix PR branch's path", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    fake.branches.add("warden");
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 409,
      body: {
        error: `Branch ${branchOf(finding)} can't be made on the repo: a branch's name is in its path, such as warden; rename that branch to open Fix PRs`,
      },
    });
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it("answers 502 when the PR request fails, keeps the branch, and the next POST names it in a 409", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted), failAt: "pull" });
    const { app, logLines } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 502,
      body: { error: "GitHub didn't answer; no Fix PR was opened" },
    });
    expect(await fixPrRows(team)).toHaveLength(0);
    expect(fake.branches.has(branchOf(finding))).toBe(true);
    const logged = logEntries(logLines().join("\n")).find(
      (entry) => entry.message === "GitHub didn't answer; no Fix PR was opened",
    );
    expect(logged).toMatchObject({ team, status: 500, step: expect.any(String) });

    const next = await post(app, team, finding.id);
    expect(next.status).toBe(409);
    expect(JSON.stringify(next.body)).toContain(branchOf(finding));
  });

  it("commits a guard/mcp-server-unpinned fix pinned at the registry's latest version, naming the server", async () => {
    const mcp = `${JSON.stringify({ mcpServers: { tools: { command: "npx", args: ["-y", "@acme/tools"] } } }, null, 2)}\n`;
    const { team, repoId, granted, finding } = await fixableTeam({
      finding: { rule: "guard/mcp-server-unpinned", path: ".mcp.json" },
    });
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: { ".mcp.json": mcp },
      npm: { "@acme/tools": "2.4.1" },
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(201);
    const contents = fake.calls.find((c) => c.method === "PUT");
    expect(contents?.url.pathname).toBe(`/repos/${FULL_NAME}/contents/.mcp.json`);
    expect(JSON.parse(fromBase64(String(contents?.body?.content)))).toEqual({
      mcpServers: { tools: { command: "npx", args: ["-y", "@acme/tools@2.4.1"] } },
    });
    const pull = fake.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/pulls"));
    expect(String(pull?.body?.body)).toContain("`tools`");
  });

  it.each([
    ["a Lead", LEAD],
    ["an Admin", ADMIN],
  ])("lets %s open a Fix PR as a Member does", async (_who, as) => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const { app } = fixApp(fakeGitHub({ repoId, installations: installationsOf(granted) }));

    const res = await post(app, team, finding.id, as);

    expect(res.status).toBe(201);
    expect(FixPrBody.parse(res.body).opened_by).toBe(as);
  });
});

describe("POST /api/guard/findings/:id/fix-pr: a PR found on GitHub is Warden's only when the write app made it alone (#347)", () => {
  /** The 409 for PR `number` from `branch` that the write app didn't open alone. */
  const notWardens = (number: number, branch: string) =>
    `PR #${number} from ${branch} wasn't opened by Warden's write app alone; close the PR and delete the branch to open a new Fix PR`;

  /** The fake's reads of the open PRs from a branch. */
  const openPullReads = (fake: Fake) =>
    fake.calls.filter((c) => c.method === "GET" && c.url.pathname === `/repos/${FULL_NAME}/pulls`);

  /** A Team whose Fix PR branch is already on the repo, with `pull` (the bot's by default) open from it. */
  async function branchThere(pull: (branch: string) => Pull) {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    fake.branches.add(branchOf(finding));
    fake.pulls.push(pull(branchOf(finding)));
    return { team, finding, fake, ...fixApp(fake) };
  }

  it.each([
    ["a person opened", (head: string) => ({ ...botPull(9, head), author: PUSHER })],
    [
      "another app's bot opened",
      (head: string) => ({
        ...botPull(9, head),
        author: "warden-reader[bot]",
        commits: ["warden-reader[bot]"],
      }),
    ],
    [
      "the bot opened with a second commit by a person",
      (head: string) => ({ ...botPull(9, head), commits: [BOT, PUSHER] }),
    ],
    [
      "the bot opened whose one commit is a person's",
      (head: string) => ({ ...botPull(9, head), commits: [PUSHER] }),
    ],
    [
      "the bot opened whose one commit's author GitHub links to no account",
      (head: string) => ({ ...botPull(9, head), commits: [null] }),
    ],
  ])(
    "answers 409 naming an open PR from the branch already there that %s, after one look, recording and writing nothing",
    async (_case, pull) => {
      const { team, finding, fake, app } = await branchThere(pull);

      const res = await post(app, team, finding.id);

      expect(res).toMatchObject({ status: 409, body: { error: notWardens(9, branchOf(finding)) } });
      expect(openPullReads(fake)).toHaveLength(1);
      // The one write sent is the branch create GitHub refused, the branch being there.
      expect(fake.writes().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
        `POST /repos/${FULL_NAME}/git/refs`,
      ]);
      expect(await fixPrRows(team)).toHaveLength(0);
    },
  );

  it("answers 409 naming the recorded PR, still open, once a person's commit is pushed on top, writing nothing", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);
    expect((await post(app, team, finding.id)).status).toBe(201);
    const [pull] = fake.pulls;
    if (pull === undefined) throw new Error("the first POST opened no PR");
    pull.commits.push(PUSHER);
    const writes = fake.writes().length;

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 409,
      body: { error: notWardens(pull.number, branchOf(finding)) },
    });
    expect(fake.writes()).toHaveLength(writes);
    expect(await fixPrRows(team)).toHaveLength(1);
  });

  it("answers 502 when GitHub answers 500 to the PR's commits read, logs its step, and records nothing", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted), failAt: "commits" });
    fake.branches.add(branchOf(finding));
    fake.pulls.push(botPull(9, branchOf(finding)));
    const { app, logLines } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 502,
      body: { error: "GitHub didn't answer; no Fix PR was opened" },
    });
    const logged = logEntries(logLines().join("\n")).find(
      (entry) => entry.message === "GitHub didn't answer; no Fix PR was opened",
    );
    expect(logged).toMatchObject({ team, status: 500, step: "GitHub's Fix PR commits read" });
    expect(await fixPrRows(team)).toHaveLength(0);
  });
});

describe("POST /api/guard/findings/:id/fix-pr: the write grant (stories 5 and 15)", () => {
  it("refuses before the Team holds a write grant, and opens the PR after it", async () => {
    const installationId = newInstallation();
    const { team, repoId, finding } = await fixableTeam({ granted: [] });
    const fake = fakeGitHub({ repoId, installations: installationsOf([installationId]) });
    const { app } = fixApp(fake);

    const before = await post(app, team, finding.id);
    expect(before).toMatchObject({
      status: 409,
      body: { error: "Grant write access on Setup to open Fix PRs" },
    });
    expect(fake.calls).toEqual([]);

    await writeGrants.grant(team, { installationId, grantedBy: ADMIN });
    expect((await post(app, team, finding.id)).status).toBe(201);
  });

  it("writes revoked when the installation is gone, asks for the grant again, and lists it no more", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const [installationId = 0] = granted;
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted, { [installationId]: { status: 404 } }),
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/grant write access again on Setup/);
    const revoked = await grantRows(team, "revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      caused_by: MEMBER,
      installation_id: String(installationId),
    });
    const grants = await call(app, "GET", team, "/api/github/write-grant");
    expect(WriteGrantsBody.parse(grants.body).installations).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it.each([403, 422])("writes no revoked row when the token request answers %i", async (status) => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const [installationId = 0] = granted;
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted, { [installationId]: { status } }),
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({ status: 409, body: { error: "No write grant reaches this repo" } });
    expect(await grantRows(team, "revoked")).toHaveLength(0);
    expect(fake.writes()).toEqual([]);
  });

  it("uses the second installation's token when the first doesn't reach the repo", async () => {
    const first = newInstallation();
    const second = first + 1;
    const { team, repoId, finding } = await fixableTeam({ granted: [first, second] });
    const fake = fakeGitHub({
      repoId,
      installations: { [first]: { status: 422 }, [second]: {} },
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(201);
    const tokenCalls = fake.calls.filter((c) => c.url.pathname.endsWith("/access_tokens"));
    expect(tokenCalls.map((c) => c.url.pathname)).toEqual([
      `/app/installations/${first}/access_tokens`,
      `/app/installations/${second}/access_tokens`,
    ]);
    const used = fake.gitHub().filter((c) => !c.url.pathname.endsWith("/access_tokens"));
    expect(used.length).toBeGreaterThan(0);
  });

  it("refuses a token holding workflows write beside the three, writing nothing", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const [installationId = 0] = granted;
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted, {
        [installationId]: { permissions: { ...WRITE_APP, workflows: "write" } },
      }),
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 409,
      body: { error: "This installation's permissions aren't the write app's" },
    });
    expect(fake.writes()).toEqual([]);
    expect(await fixPrRows(team)).toHaveLength(0);
  });
});

describe("POST /api/guard/findings/:id/fix-pr: refusals, each writing nothing", () => {
  it("refuses a Finding whose repo isn't one of the Team's Repo Assets, before any GitHub request", async () => {
    const { team, repoId, granted } = await fixableTeam();
    const elsewhere = await seedGuardFinding(team, { ref: "https://github.com/example/other" });
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    const res = await post(app, team, elsewhere.id);

    expect(res).toMatchObject({
      status: 409,
      body: { error: "This Finding's repo isn't one of the Team's Repo Assets" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("answers fixedEdit's already-fixed reason when the settings already deny both .env entries", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: {
        [SETTINGS]: JSON.stringify({ permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] } }),
      },
    });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 409,
      body: { error: "already fixed on the default branch; the next Scan marks it Fixed" },
    });
    expect(fake.writes()).toEqual([]);
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it("answers 503 when the write app isn't set up here", async () => {
    const { team, finding } = await fixableTeam();
    const { app } = fixApp();

    const res = await post(app, team, finding.id);

    expect(res).toMatchObject({
      status: 503,
      body: { error: "Fix PRs aren't set up on this Warden" },
    });
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it(`answers 429 with Retry-After for the Team's POST past ${FIX_PRS_PER_HOUR} in an hour`, async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);
    for (let i = 0; i < FIX_PRS_PER_HOUR; i++) {
      expect((await post(app, team, randomUUID())).status).toBe(404);
    }

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(429);
    expect(Number(res.retryAfter)).toBeGreaterThan(0);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["an id that doesn't exist", randomUUID()],
    ["an id holding a NUL", "abc\0def"],
  ])("answers 404 for %s, before any GitHub request", async (_case, id) => {
    const { team, repoId, granted } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    expect(await post(app, team, id)).toMatchObject({
      status: 404,
      body: { error: "No such Finding" },
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [
      "a guard/permission-skip Finding",
      { rule: "guard/permission-skip" as const },
      "no Fix PR for this Rule",
    ],
    [
      "a guard/mcp-server-unpinned Finding under .github/workflows/",
      { rule: "guard/mcp-server-unpinned" as const, path: ".github/workflows/.mcp.json" },
      "Warden never edits .github/workflows/",
    ],
  ])("answers 400 for %s", async (_case, fields, reason) => {
    const { team, repoId, granted, finding } = await fixableTeam({ finding: fields });
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    expect(await post(app, team, finding.id)).toMatchObject({
      status: 400,
      body: { error: reason },
    });
    expect(fake.calls).toEqual([]);
  });

  it("answers 400 for a Patch Finding", async () => {
    const { team, repoId, granted } = await fixableTeam();
    const patch = patchFinding(team, randomUUID(), { cve: "CVE-2024-0001" });
    await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(patch)).execute());
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    expect(await post(app, team, patch.id)).toMatchObject({
      status: 400,
      body: { error: "no Fix PR for this Rule" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("answers 409 naming the Status of a Finding that isn't Open", async () => {
    const { team, repoId, granted, finding } = await fixableTeam({
      finding: {
        status: "accepted",
        accepted_reason: "Reviewed: the file is test data",
        accepted_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    });
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    const res = await post(app, team, finding.id);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Accepted");
    expect(fake.calls).toEqual([]);
  });

  it("answers 409 for a settings file that isn't JSON", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: { [SETTINGS]: "{ not json" },
    });
    const { app } = fixApp(fake);

    expect(await post(app, team, finding.id)).toMatchObject({
      status: 409,
      body: { error: `${SETTINGS} isn't valid JSON` },
    });
    expect(fake.writes()).toEqual([]);
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it("answers 502 when the npm registry answers 500, before anything is written to GitHub", async () => {
    const mcp = JSON.stringify({
      mcpServers: { tools: { command: "npx", args: ["-y", "acme-tools"] } },
    });
    const { team, repoId, granted, finding } = await fixableTeam({
      finding: { rule: "guard/mcp-server-unpinned", path: ".mcp.json" },
    });
    const fake = fakeGitHub({
      repoId,
      installations: installationsOf(granted),
      files: { ".mcp.json": mcp },
      failAt: "npm",
    });
    const { app } = fixApp(fake);

    expect(await post(app, team, finding.id)).toMatchObject({
      status: 502,
      body: { error: "The npm registry didn't answer; no Fix PR was opened" },
    });
    expect(fake.writes()).toEqual([]);
    expect(await fixPrRows(team)).toHaveLength(0);
  });

  it("answers 502 when GitHub answers 500 to the repo read by id", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted), failAt: "repo" });
    const { app } = fixApp(fake);

    expect(await post(app, team, finding.id)).toMatchObject({
      status: 502,
      body: { error: "GitHub didn't answer; no Fix PR was opened" },
    });
    expect(fake.writes()).toEqual([]);
    expect(await fixPrRows(team)).toHaveLength(0);
  });
});

describe("the Fix PR route keeps each Team to its own Findings (story 15)", () => {
  it("answers Team B 404 on Team A's Finding, for POST and GET, with no GitHub request", async () => {
    const a = await fixableTeam();
    const fakeA = fakeGitHub({ repoId: a.repoId, installations: installationsOf(a.granted) });
    const appA = fixApp(fakeA).app;
    expect((await post(appA, a.team, a.finding.id)).status).toBe(201);
    const rowsBefore = await fixPrRows(a.team);

    const b = await fixableTeam();
    const fakeB = fakeGitHub({ repoId: b.repoId, installations: installationsOf(b.granted) });
    const { app } = fixApp(fakeB);

    expect(await post(app, b.team, a.finding.id)).toMatchObject({
      status: 404,
      body: { error: "No such Finding" },
    });
    expect(await get(app, b.team, a.finding.id)).toMatchObject({
      status: 404,
      body: { error: "No such Finding" },
    });
    expect(fakeB.calls).toEqual([]);
    expect(await fixPrRows(a.team)).toEqual(rowsBefore);
    expect((await writeGrants.list(a.team)).map((grant) => grant.installationId)).toEqual(
      a.granted,
    );
  });

  it("answers 401 to a POST and a GET with no session", async () => {
    const { team, repoId, granted, finding } = await fixableTeam();
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });
    const { app } = fixApp(fake);

    for (const method of ["POST", "GET"] as const) {
      const res = await call(app, method, team, fixPrPath(finding.id), { signedIn: false });
      expect(res.status).toBe(401);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("GET /api/guard/findings/:id/fix-pr", () => {
  it("answers fixable false and no PR for a guard/permission-skip Finding, with and without the write app", async () => {
    const { team, repoId, granted, finding } = await fixableTeam({
      finding: { rule: "guard/permission-skip" },
    });
    const fake = fakeGitHub({ repoId, installations: installationsOf(granted) });

    for (const { app } of [fixApp(fake), fixApp()]) {
      const res = await get(app, team, finding.id);
      expect(res.status).toBe(200);
      expect(FindingFixPrBody.parse(res.body)).toEqual({ fixable: false, fix_pr: null });
    }
    expect(fake.calls).toEqual([]);
  });
});
