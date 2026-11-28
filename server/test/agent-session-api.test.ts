// Story 9's session record at the API (spec #225, slice 9b): `GET /api/guard/findings/:id/session`, an Agent session
// Finding's pseudonym and its started, ended and judged times, read from `agent_sessions` after the Judge has dropped
// the events. A session's events are posted through `POST /api/hook/events` with `X-Warden-Developer`, then judged in
// process as the Judge Job judges it, with OpenRouter faked at its HTTP boundary. On the suite's shared database, with
// Teams of this file's own per case.
import { randomUUID } from "node:crypto";
import {
  AgentSessionBody,
  fingerprint,
  FindingsBody,
  type Finding,
  type Observation,
} from "@warden/contracts";
import { DEMO_OBSERVATIONS } from "@warden/contracts/demo";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { judgeSettings } from "../src/config.ts";
import { createFindings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import { createLogger } from "../src/log.ts";
import { createAgentSessions } from "../src/modules/guard/agent-sessions.ts";
import { hookEventRoutes } from "../src/modules/guard/hook-event-routes.ts";
import { createHookSettings, type HookSettings } from "../src/modules/guard/hook-settings.ts";
import { AGENT_SENDS_SECRETS } from "../src/modules/guard/judge-rules.ts";
import { HOOK_EVENTS_PATH } from "../src/modules/guard/managed-settings.ts";
import { pseudonym } from "../src/modules/guard/pseudonym.ts";
import { agentSessionRoutes } from "../src/modules/guard/session-routes.ts";
import { runJudgeJob } from "../src/scan-job.ts";
import { judge, MOVE_RULES } from "../src/wiring.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { fakeOpenRouter, verdict } from "./fake-openrouter.ts";
import { ADMIN, call, newTeam, testApp, testKey } from "./helpers.ts";

const MEMBER = "user_member";
const PSEUDONYM_KEY = Buffer.alloc(32, 7);
/** The developer's name the hook sends: never in an answer. */
const DEVELOPER = `hazel-${randomUUID()}`;

let key: CryptoKey;
let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let hookSettings: HookSettings;

beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  hookSettings = createHookSettings({ withTeam });
});

afterAll(() => pool.end());

/** The app with the hook endpoint and the session record's route, as the start-up file mounts them. */
function app() {
  const agentSessions = createAgentSessions({ withTeam });
  return testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      hookEventRoutes({
        hookSettings,
        agentSessions,
        pseudonymKey: PSEUDONYM_KEY,
        behindCloudRun: true,
        logger: createLogger(() => {}),
      }),
      agentSessionRoutes({
        findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
        agentSessions,
      }),
    ],
  }).app;
}

const SESSION_EVENTS: Record<string, unknown>[] = [
  { hook_event_name: "SessionStart", source: "startup" },
  {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    tool_input: { command: "cat .env" },
    tool_response: { stdout: "PASTE_TOKEN=abc" },
  },
  { hook_event_name: "SessionEnd", reason: "exit" },
];

/**
 * A Team of an Admin and a Member at the content tier, one session posted through the hook endpoint with
 * `X-Warden-Developer`, judged with the fake model into one Finding. The Team, the app, the session and its Finding.
 */
async function judgedSession() {
  const team = await newTeam(withTeam, [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ]);
  const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });
  await hookSettings.setPrivacyTier(team, { tier: "content", setBy: ADMIN });
  const served = app();
  const sessionId = `sess-${randomUUID()}`;
  for (const body of SESSION_EVENTS) {
    const res = await served.request(
      new Request(new URL(HOOK_EVENTS_PATH, "http://warden.test"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.9",
          "X-Warden-Developer": DEVELOPER,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ session_id: sessionId, ...body }),
      }),
    );
    expect(res.status).toBe(204);
  }
  const fake = fakeOpenRouter(() =>
    verdict([{ rule_id: AGENT_SENDS_SECRETS, summary: "The agent read .env", event_seqs: [1] }]),
  );
  const code = await runJudgeJob({
    team,
    sessionId,
    judge: judge({
      withTeam,
      settings: judgeSettings({
        OPENROUTER_API_KEY: "sk-or-v1-test",
        WARDEN_JUDGE_MODEL: "m/judge",
      }),
      fetch: fake.fetch,
      logger: createLogger(() => {}),
    }),
    logger: createLogger(() => {}),
  });
  expect(code).toBe(0);
  const read = await call(served, key, "GET", "/api/findings", { as: MEMBER, teamId: team });
  const finding = FindingsBody.parse(read.body).findings.find(
    (f) => f.asset.kind === "agent_session" && f.asset.ref === sessionId,
  );
  expect(finding).toBeDefined();
  return { team, app: served, sessionId, finding: finding! };
}

/** An Open Guard Finding from `observation` on `team`, written straight into `findings`. Returns it. */
async function seedFinding(team: string, observation: Observation): Promise<Finding> {
  const finding: Finding = {
    ...observation,
    id: randomUUID(),
    team,
    module: "guard",
    fingerprint: fingerprint(observation.rule_id, observation.location),
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
  };
  await withTeam(team, (tx) => tx.insertInto("findings").values(toRow(finding)).execute());
  return finding;
}

const sessionPath = (id: string) => `/api/guard/findings/${id}/session`;

describe("GET /api/guard/findings/:id/session", () => {
  it("answers a Member a Judge Finding's session pseudonym and its started, ended and judged times", async () => {
    const { team, app: served, finding } = await judgedSession();

    const res = await call(served, key, "GET", sessionPath(finding.id), {
      as: MEMBER,
      teamId: team,
    });

    expect(res.status).toBe(200);
    const body = AgentSessionBody.parse(res.body);
    expect(body.developer).toBe(pseudonym(PSEUDONYM_KEY, team, DEVELOPER));
    expect(body.ended_at).not.toBeNull();
    expect(body.judged_at).not.toBeNull();
    const [started, ended, judged] = [body.started_at, body.ended_at!, body.judged_at!].map((at) =>
      new Date(at).getTime(),
    );
    expect(started).toBeLessThanOrEqual(ended!);
    expect(ended).toBeLessThanOrEqual(judged!);
  });

  it("holds no developer's name and no event content: exactly its four keys", async () => {
    const { team, app: served, finding } = await judgedSession();

    const res = await call(served, key, "GET", sessionPath(finding.id), {
      as: MEMBER,
      teamId: team,
    });

    expect(Object.keys(res.body as object).sort()).toEqual([
      "developer",
      "ended_at",
      "judged_at",
      "started_at",
    ]);
    expect(res.text).not.toContain(DEVELOPER);
    expect(res.text).not.toContain("cat .env");
    expect(res.text).not.toContain("PASTE_TOKEN");
  });

  it("answers Team B 404 No such Finding for Team A's session Finding, the same body as an id no Team has", async () => {
    const { finding } = await judgedSession();
    const other = await newTeam(withTeam, [[MEMBER, "member"]]);
    const served = app();

    const theirs = await call(served, key, "GET", sessionPath(finding.id), {
      as: MEMBER,
      teamId: other,
    });
    const nobodys = await call(served, key, "GET", sessionPath(randomUUID()), {
      as: MEMBER,
      teamId: other,
    });

    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ error: "No such Finding" });
    expect(nobodys.status).toBe(404);
    expect(nobodys.body).toEqual(theirs.body);
  });

  it("answers 404 in its own words for a Finding on a Repo", async () => {
    const team = await newTeam(withTeam, [[MEMBER, "member"]]);
    const finding = await seedFinding(team, DEMO_OBSERVATIONS.secret);

    const res = await call(app(), key, "GET", sessionPath(finding.id), {
      as: MEMBER,
      teamId: team,
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "This Finding isn't on an Agent session" });
  });

  it("answers 404 in its own words for the demo's session Finding, whose session has no record", async () => {
    const team = await newTeam(withTeam, [[MEMBER, "member"]]);
    const finding = await seedFinding(team, DEMO_OBSERVATIONS.printed);
    expect(finding.asset).toEqual({ kind: "agent_session", ref: "session-demo-7f3a" });

    const res = await call(app(), key, "GET", sessionPath(finding.id), {
      as: MEMBER,
      teamId: team,
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Warden holds no record of this session" });
  });

  it("answers 401 to a request with no session", async () => {
    const res = await app().request(sessionPath(randomUUID()));

    expect(res.status).toBe(401);
  });

  it.each([
    ["a NUL in it", "%00"],
    ["not an id at all", "not-a-finding"],
  ])("answers 404 No such Finding, never a 500, for an id with %s", async (_, id) => {
    const team = await newTeam(withTeam, [[MEMBER, "member"]]);

    const res = await call(app(), key, "GET", sessionPath(id), { as: MEMBER, teamId: team });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No such Finding" });
  });
});
