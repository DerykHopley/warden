// Stories 5, 6 and 8 at the API: any person in a Team reads one Patch Finding's assessment (whether the version is
// affected and why, the fix, who acts, the priority and its due date), worked out when asked, and no Team reads
// another's. Through the real app with Patch's routes mounted as the start-up file mounts them, "today" fixed at the
// snapshot's date, on the suite's shared database (which holds the CVE snapshot) with Teams of this file's own.
import { randomUUID } from "node:crypto";
import {
  FindingsBody,
  PatchAssessment,
  Product,
  type Finding,
  type ProductInput,
} from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createFindings, type Findings } from "../src/findings/index.ts";
import { createSaveLimit } from "../src/modules/patch/save-limit.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { call, newTeam, patchMount, testApp, testKey } from "./helpers.ts";

const MEMBER = "user_member";
const LEAD = "user_lead";
const CVE = "CVE-2025-3248"; // Langflow before 1.3.0: in KEV, EPSS 99.988th percentile
/** The snapshot's date, as "today". */
const TODAY = new Date("2026-10-13T09:30:00Z");

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let findings: Findings;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  findings = createFindings({ withTeam, moveRules: {} });
  ({ app } = testApp({ publicPem, withTeam, mount: patchMount(withTeam, { now: () => TODAY }) }));
});

afterAll(() => pool.end());

const team = () =>
  newTeam(withTeam, [
    [MEMBER, "member"],
    [LEAD, "lead"],
  ]);

const langflow = (version: string | null): ProductInput["dependencies"][number] => ({
  framework: "langflow",
  version,
  usage: "self_hosted",
  internet_facing: true,
});

const flows = (version: string | null): ProductInput => ({
  name: "Flows",
  repo_urls: [],
  dependencies: [langflow(version)],
});

/** Team A's Lead saves Product "Flows"; its id, and its Finding for CVE-2025-3248. */
async function savedFlows(teamId: string, version: string | null, on = app) {
  const saved = await call(on, key, "POST", "/api/products", {
    as: LEAD,
    teamId,
    body: flows(version),
  });
  expect(saved.status).toBe(201);
  const productId = Product.parse(saved.body).id;
  return { productId, finding: await findingFor(teamId, productId) };
}

async function findingFor(teamId: string, productId: string): Promise<Finding> {
  const { status, body } = await call(app, key, "GET", "/api/findings", { as: MEMBER, teamId });
  expect(status).toBe(200);
  const [finding, ...more] = FindingsBody.parse(body).findings.filter(
    (f) =>
      f.asset.ref === productId &&
      f.location.kind === "dependency" &&
      f.location.vulnerability === CVE,
  );
  expect(more).toEqual([]);
  return finding!;
}

const assessmentPath = (findingId: string) => `/api/patch/findings/${findingId}/assessment`;

/** A Member's read of the assessment: 200, parsed with the PatchAssessment contract. */
async function assessment(teamId: string, findingId: string, on = app) {
  const { status, body } = await call(on, key, "GET", assessmentPath(findingId), {
    as: MEMBER,
    teamId,
  });
  expect(status).toBe(200);
  return PatchAssessment.parse(body);
}

describe("a Patch Finding's assessment (stories 5 and 6)", () => {
  it("says Langflow 1.2.0 is affected, 1.3.0 fixes it, and you act", async () => {
    const teamId = await team();
    const { finding } = await savedFlows(teamId, "1.2.0");

    const answer = await assessment(teamId, finding.id);

    expect(answer).toMatchObject({
      finding_id: finding.id,
      cve_id: CVE,
      dependency: langflow("1.2.0"),
      verdict: "affected",
      fixed_version: "1.3.0",
      who_acts: "you",
    });
    expect(answer.reason).toContain("1.3.0");
  });

  it("is urgent and overdue on the KEV deadline, with KEV, EPSS and the NVD and OSV links", async () => {
    const teamId = await team();
    const { finding } = await savedFlows(teamId, "1.2.0");

    const answer = await assessment(teamId, finding.id);

    expect(answer.priority).toEqual({
      level: "urgent",
      reasons: ["in KEV", "EPSS 99th percentile", "internet-facing"],
      due_date: "2025-05-26",
      due_from: "KEV deadline",
      overdue: true,
    });
    expect(answer.kev).toMatchObject({ date_added: "2025-05-05", due_date: "2025-05-26" });
    expect(answer.epss?.percentile).toBe(0.99988);
    expect(answer.links.nvd).toBe(`https://nvd.nist.gov/vuln/detail/${CVE}`);
    expect(answer.links.osv).toContain("https://osv.dev/vulnerability/GHSA-rvqx-wpfh-mfx7");
  });

  it("reads verdict unknown, with the verdict's reason, for a dependency with no version", async () => {
    const teamId = await team();
    const { finding } = await savedFlows(teamId, null);

    const answer = await assessment(teamId, finding.id);

    expect(answer).toMatchObject({
      verdict: "unknown",
      reason: "no version given",
      dependency: langflow(null),
    });
  });

  it("isn't overdue once Accepted until a date ahead, nor once Fixed by the upgrade to 1.3.0", async () => {
    const teamId = await team();
    const { productId, finding } = await savedFlows(teamId, "1.2.0");
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const accepted = await call(app, key, "POST", `/api/findings/${finding.id}/accept`, {
      as: LEAD,
      teamId,
      body: { reason: "Behind the VPN until the upgrade", until },
    });
    expect(accepted.status).toBe(200);

    expect((await assessment(teamId, finding.id)).priority.overdue).toBe(false);

    const upgraded = await call(app, key, "PUT", `/api/products/${productId}`, {
      as: LEAD,
      teamId,
      body: flows("1.3.0"),
    });
    expect(upgraded.status).toBe(200);
    expect((await findingFor(teamId, productId)).status).toBe("fixed");

    const fixed = await assessment(teamId, finding.id);
    expect(fixed.priority.overdue).toBe(false);
    expect(fixed.dependency).toEqual(langflow("1.3.0"));
  });

  it("answers a Fixed Finding with no dependency and no one to act once Langflow is removed", async () => {
    const teamId = await team();
    const { productId, finding } = await savedFlows(teamId, "1.2.0");
    const removed = await call(app, key, "PUT", `/api/products/${productId}`, {
      as: LEAD,
      teamId,
      body: { ...flows(null), dependencies: [] },
    });
    expect(removed.status).toBe(200);

    const answer = await assessment(teamId, finding.id);

    expect(answer).toMatchObject({ dependency: null, who_acts: null, verdict: "affected" });
  });
});

describe("refusals", () => {
  it("answers Team B's Lead 404 for Team A's Finding, naming nothing of Team A's (story 8)", async () => {
    const teamA = await team();
    const teamB = await team();
    const { productId, finding } = await savedFlows(teamA, "1.2.0");

    const { status, body, text } = await call(app, key, "GET", assessmentPath(finding.id), {
      as: LEAD,
      teamId: teamB,
    });

    expect(status).toBe(404);
    expect(body).toEqual({ error: expect.any(String) });
    for (const of of [teamA, productId, finding.id, "Flows", CVE, "langflow"]) {
      expect(text).not.toContain(of);
    }
  });

  it("answers 404 for an id the Team doesn't have, an id holding a NUL, and another module's Finding", async () => {
    const teamId = await team();
    await savedFlows(teamId, "1.2.0");
    const repo = { kind: "repo", ref: "https://github.com/example/app" } as const;
    const rule = "guard/agent-can-read-env";
    await findings.reconcile({
      id: randomUUID(),
      team: teamId,
      module: "guard",
      started_at: new Date().toISOString(),
      assets: [repo],
      rules: [rule],
      observations: [
        {
          asset: repo,
          rule_id: rule,
          location: { kind: "file", path: ".claude/settings.json" },
          severity: "high",
          title: "The agent can read .env files",
          evidence: { summary: "permissions.allow lets the agent read .env" },
        },
      ],
    });
    const guard = (await findings.list(teamId)).find((f) => f.module === "guard")!;

    // The NUL row stays a 404 even without pathId's NUL check (#245): the assessment's read lists the Team's Findings
    // and matches the id among them in memory, so the id never reaches a query and Postgres can't refuse it as a 500.
    // The check itself is proven in path-id.test.ts and on the routes that do query by id; this row catches a read
    // that starts to.
    for (const id of [randomUUID(), "a%00b", guard.id]) {
      const { status, body } = await call(app, key, "GET", assessmentPath(id), {
        as: MEMBER,
        teamId,
      });
      expect([id, status, body]).toEqual([id, 404, { error: expect.any(String) }]);
    }
  });

  it("answers 404 naming the CVE for a Patch Finding whose CVE the snapshot doesn't hold", async () => {
    const teamId = await team();
    const { productId } = await savedFlows(teamId, "1.2.0");
    const asset = { kind: "product", ref: productId } as const;
    const unloaded = "CVE-1999-0001";
    await findings.reconcile({
      id: randomUUID(),
      team: teamId,
      module: "patch",
      started_at: new Date().toISOString(),
      assets: [asset],
      rules: ["patch/known-vulnerability"],
      observations: [
        {
          asset,
          rule_id: "patch/known-vulnerability",
          location: {
            kind: "dependency",
            package: "pkg:pypi/langflow",
            version: "1.2.0",
            vulnerability: unloaded,
          },
          severity: "high",
          title: `${unloaded}: a CVE a newer snapshot dropped`,
          evidence: { summary: "Stored before the snapshot changed." },
        },
      ],
    });
    const stale = (await findings.list(teamId)).find(
      (f) => f.location.kind === "dependency" && f.location.vulnerability === unloaded,
    )!;

    const { status, body } = await call(app, key, "GET", assessmentPath(stale.id), {
      as: MEMBER,
      teamId,
    });

    expect(status).toBe(404);
    expect(body).toEqual({ error: expect.stringContaining(unloaded) });
    expect((body as { error: string }).error).toMatch(/CVE snapshot/);
  });

  it("answers a signed-out request 401", async () => {
    const res = await app.request(assessmentPath(randomUUID()));
    expect(res.status).toBe(401);
  });

  it("doesn't count a Member's read against the Product save limit", async () => {
    const teamId = await team();
    const { app: limited } = testApp({
      publicPem,
      withTeam,
      mount: patchMount(withTeam, { now: () => TODAY, saveLimit: createSaveLimit({ max: 1 }) }),
    });
    const { finding } = await savedFlows(teamId, "1.2.0", limited);
    const again = await call(limited, key, "POST", "/api/products", {
      as: LEAD,
      teamId,
      body: { ...flows("1.2.0"), name: "Flows 2" },
    });
    expect(again.status).toBe(429);

    await assessment(teamId, finding.id, limited);
    await assessment(teamId, finding.id, limited);
  });
});
