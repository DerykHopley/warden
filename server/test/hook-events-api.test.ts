// The hook endpoint (spec #225, slice 1, #183): `POST /api/hook/events` takes Claude Code's hook events with the Team's
// hook token and stores the fields the Team's Privacy tier keeps, redacted, under the token's Team and the developer's
// pseudonym (story 8, story 15 in part; threats H1, H2, H3, H6, H7, H8). A stored SessionEnd starts the Judge for its
// session, with a fake starter (story 9, #444). Through the real app with the hook event routes, on the suite's shared
// database, each case with Teams of its own and an endpoint (so its limits) of its own.
import { randomBytes, randomUUID } from "node:crypto";
import type { PrivacyTier } from "@warden/contracts";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createAgentSessions,
  type AgentSessionTables,
} from "../src/modules/guard/agent-sessions.ts";
import {
  HOOK_BODY_LIMIT_BYTES,
  HOOK_EVENTS_PER_MINUTE,
  HOOK_REFUSALS_PER_MINUTE,
  hookEventRoutes,
} from "../src/modules/guard/hook-event-routes.ts";
import { createHookSettings, type HookSettings } from "../src/modules/guard/hook-settings.ts";
import { HOOK_EVENTS_PATH } from "../src/modules/guard/managed-settings.ts";
import { pseudonym } from "../src/modules/guard/pseudonym.ts";
import { createLogger } from "../src/log.ts";
import type { JudgeJobStarter } from "../src/scans.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, newTeam, testApp, testKey } from "./helpers.ts";
import { ANTHROPIC_KEY, AWS_KEY, GITHUB_TOKEN, mask, STRIPE_KEY } from "./secret-fixtures.ts";

let publicPem: string;
let pool: pg.Pool;
let withTeam: WithTeam;
let hookSettings: HookSettings;

beforeAll(async () => {
  ({ publicPem } = await testKey());
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  hookSettings = createHookSettings({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

/** The tests' own pseudonym key. */
const PSEUDONYM_KEY = randomBytes(32);

/** Every log line any app in this file wrote, for the last case. */
const allLines: string[] = [];

/** What the cases plant in bodies, so the logs can be searched for it. */
const PLANTED = `planted-${randomUUID()}`;

/** A clock that moves only when a case advances it. */
function fakeClock(start = Date.now()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/**
 * The app with the hook event routes (the pseudonym key unless `pseudonymKey` is null), as on Cloud Run, with no Judge
 * starter unless `startJudgeJob` is given. `lines` are the app's own; `ownLines` the endpoint's, from its logger.
 */
function eventsApp(
  options: {
    hookSettings?: HookSettings;
    now?: () => number;
    pseudonymKey?: Buffer | null;
    startJudgeJob?: JudgeJobStarter;
  } = {},
) {
  const ownLines: string[] = [];
  const logger = createLogger((line) => ownLines.push(line));
  const routes = hookEventRoutes({
    hookSettings: options.hookSettings ?? hookSettings,
    agentSessions: createAgentSessions({ withTeam }),
    pseudonymKey:
      options.pseudonymKey === null ? undefined : (options.pseudonymKey ?? PSEUDONYM_KEY),
    behindCloudRun: true,
    now: options.now,
    startJudgeJob: options.startJudgeJob,
    logger,
  });
  const { app, lines } = testApp({ publicPem, withTeam, moduleRoutes: [routes] });
  return { app, lines, ownLines, flush: () => allLines.push(...lines, ...ownLines) };
}

/** A Judge starter that records each start, and throws `failure` when given. */
function fakeJudge(failure?: Error) {
  const calls: { sessionId: string; team: string }[] = [];
  const start: JudgeJobStarter = async (input) => {
    calls.push(input);
    if (failure !== undefined) throw failure;
  };
  return { calls, start };
}

type App = ReturnType<typeof eventsApp>["app"];

/** A Team with a hook token, at `tier` when given. */
async function teamWithToken(tier?: PrivacyTier) {
  const team = await newTeam(withTeam);
  const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });
  if (tier !== undefined) await hookSettings.setPrivacyTier(team, { tier, setBy: ADMIN });
  return { team, token };
}

/** A session id no other case uses. */
const newSession = () => `sess-${randomUUID()}`;

/** An address no other case uses. */
const newAddress = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

/** An event of Claude Code's shape. */
const event = (session: string, name: string, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  hook_event_name: name,
  ...extra,
});

/**
 * A post to the events path: `body` sent as JSON, or as it is when it's a string, a stream or null (no body); `token`
 * as the Bearer token, or no Authorization when null; `address` as the X-Forwarded-For entry.
 */
async function post(
  app: App,
  {
    token,
    body,
    headers = {},
    address = "198.51.100.1",
    path = HOOK_EVENTS_PATH,
  }: {
    token: string | null;
    body: unknown;
    headers?: Record<string, string>;
    address?: string;
    path?: string;
  },
) {
  const sent: string | ReadableStream | null =
    body === null || typeof body === "string" || body instanceof ReadableStream
      ? body
      : JSON.stringify(body);
  const request = new Request(new URL(path, "http://warden.test"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": address,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: sent,
    ...(sent instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const res = await app.request(request);
  return { status: res.status, retryAfter: res.headers.get("Retry-After"), text: await res.text() };
}

/** The Team's Agent sessions and events, read as that Team. */
const tables = (team: string) =>
  withTeam(team, async (tx) => {
    const db = tx.$extendTables<AgentSessionTables>();
    return {
      sessions: await db.selectFrom("agent_sessions").selectAll().orderBy("session_id").execute(),
      events: await db.selectFrom("agent_events").selectAll().orderBy("seq").execute(),
    };
  });

/** Both tables' rows for the Team, each read whole as text. */
const tablesAsText = (team: string) =>
  withTeam(team, async (tx) => {
    const { rows } = await sql<{ row: string }>`
      select t::text as row from agent_sessions t
      union all select t::text from agent_events t`.execute(tx);
    return rows.map(({ row }) => row).join("\n");
  });

const nothingStored = { sessions: [], events: [] };

const MINUTE_MS = 60_000;

describe("POST /api/hook/events: the token (threats H1, H2)", () => {
  it("stores an event sent with the Team's token, answering 204 with an empty body", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();

    const res = await post(app, { token, body: event(session, "SessionStart") });
    flush();

    expect(res).toEqual({ status: 204, retryAfter: null, text: "" });
    const { sessions, events } = await tables(team);
    expect(sessions.map((row) => row.session_id)).toEqual([session]);
    expect(events.map((row) => row.name)).toEqual(["SessionStart"]);
  });

  it("answers 401 and stores nothing for no Authorization, a malformed token, or an unknown one", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const body = event(newSession(), "SessionStart", { note: PLANTED });
    const unknown = `${team}.${randomBytes(32).toString("base64url")}`;

    const answers = [
      await post(app, { token: null, body }),
      await post(app, { token: "not-a-token", body }),
      await post(app, { token: unknown, body }),
      await post(app, { token: null, body, headers: { Authorization: `Basic ${token}` } }),
    ];
    flush();

    expect(answers.map((res) => res.status)).toEqual([401, 401, 401, 401]);
    for (const res of answers) {
      expect(JSON.parse(res.text)).toEqual({ error: expect.any(String) });
      expect(res.text).not.toContain(PLANTED);
    }
    expect(await tables(team)).toEqual(nothingStored);
  });

  it("answers 401 for a valid token sent only as a query parameter", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token: null,
      body: event(newSession(), "SessionStart"),
      path: `${HOOK_EVENTS_PATH}?token=${encodeURIComponent(token)}`,
    });
    flush();

    expect(res.status).toBe(401);
    expect(await tables(team)).toEqual(nothingStored);
  });

  it("answers 401 for the token before a rotation more than 24 h after it, and takes it until then", async () => {
    const clock = fakeClock();
    const clocked = createHookSettings({ withTeam, now: clock.now });
    const team = await newTeam(withTeam);
    const { token: old } = await clocked.issueToken(team, { issuedBy: ADMIN });
    await clocked.issueToken(team, { issuedBy: ADMIN });
    const { app, flush } = eventsApp({ hookSettings: clocked });

    clock.advance(24 * 3_600_000 - 60_000);
    const before = await post(app, { token: old, body: event(newSession(), "SessionStart") });
    clock.advance(2 * 60_000);
    const late = newSession();
    const after = await post(app, { token: old, body: event(late, "SessionStart") });
    flush();

    expect([before.status, after.status]).toEqual([204, 401]);
    const { sessions } = await tables(team);
    expect(sessions.map((row) => row.session_id)).not.toContain(late);
  });

  it("answers the token's scheme in any case, as `signIn` reads it", async () => {
    const { token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token: null,
      body: event(newSession(), "SessionStart"),
      headers: { Authorization: `bearer ${token}` },
    });
    flush();

    expect(res.status).toBe(204);
  });
});

describe("POST /api/hook/events: the per-address limit on refused tokens (threat H1)", () => {
  it(`answers the ${HOOK_REFUSALS_PER_MINUTE + 1}st refused token from one address 429 with Retry-After, before teamFor`, async () => {
    const { team, token } = await teamWithToken();
    let teamForCalls = 0;
    const counted: HookSettings = {
      ...hookSettings,
      teamFor: (sent) => {
        teamForCalls++;
        return hookSettings.teamFor(sent);
      },
    };
    const clock = fakeClock();
    const { app, flush } = eventsApp({ hookSettings: counted, now: clock.now });
    const [first, second] = [newAddress(), "2001:db8::1"];
    const bad = `${team}.${randomBytes(32).toString("base64url")}`;
    const body = () => event(newSession(), "SessionStart");

    const statuses: number[] = [];
    for (let i = 0; i < HOOK_REFUSALS_PER_MINUTE; i++) {
      // A valid token from the same address doesn't count toward its limit.
      statuses.push((await post(app, { token, body: body(), address: first })).status);
      statuses.push((await post(app, { token: bad, body: body(), address: first })).status);
    }
    const callsBefore = teamForCalls;
    clock.advance(30_000);
    const held = await post(app, { token: bad, body: body(), address: first });
    const elsewhere = newSession();
    const other = await post(app, {
      token,
      body: event(elsewhere, "SessionStart"),
      address: second,
    });
    flush();

    expect(statuses).toEqual(
      Array.from({ length: HOOK_REFUSALS_PER_MINUTE }, () => [204, 401]).flat(),
    );
    expect(held.status).toBe(429);
    expect(held.retryAfter).toBe("30");
    expect(teamForCalls).toBe(callsBefore + 1);
    expect(other.status).toBe(204);
    const { sessions } = await tables(team);
    expect(sessions.map((row) => row.session_id)).toContain(elsewhere);
  });
});

describe("POST /api/hook/events: the Team comes from the token alone (story 15, threat H2)", () => {
  it("stores Team B's post naming Team A in its body and a header under Team B only", async () => {
    const a = await teamWithToken();
    const b = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();
    await post(app, { token: a.token, body: event(session, "SessionStart") });
    const aBefore = await tables(a.team);

    const res = await post(app, {
      token: b.token,
      body: event(session, "PostToolUse", { team: a.team, team_id: a.team, tool_name: "Bash" }),
      headers: { "X-Warden-Team": a.team },
    });
    flush();

    expect(res.status).toBe(204);
    expect(await tables(a.team)).toEqual(aBefore);
    const bRows = await tables(b.team);
    expect(bRows.sessions.map((row) => [row.team_id, row.session_id])).toEqual([[b.team, session]]);
    expect(bRows.events.map((row) => [row.team_id, row.name])).toEqual([[b.team, "PostToolUse"]]);
    // Read as Team A, none of Team B's rows show.
    const asA = await tables(a.team);
    expect([...asA.sessions, ...asA.events].every((row) => row.team_id === a.team)).toBe(true);
  });

  it("refuses the hook token as a session token: GET /api/findings answers 401 (threat H3)", async () => {
    const { token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await app.request("/api/findings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    flush();

    expect(res.status).toBe(401);
  });
});

/** Sends the Team's whole minute of events, each taken. */
async function fillMinute(app: App, token: string) {
  // Events the endpoint takes but doesn't store still count: the limit is on what the Team sends.
  for (let sent = 0; sent < HOOK_EVENTS_PER_MINUTE; sent += 20) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, () =>
        post(app, { token, body: event(newSession(), "PreToolUse") }),
      ),
    );
    expect(batch.map((res) => res.status)).toEqual(Array<number>(20).fill(204));
  }
}

describe("POST /api/hook/events: the per-Team limit (threat H6)", () => {
  it(`answers the Team's ${HOOK_EVENTS_PER_MINUTE + 1}st event in a minute 429, and counts it on its session`, async () => {
    const { team, token } = await teamWithToken();
    const other = await teamWithToken();
    const clock = fakeClock();
    const { app, flush } = eventsApp({ now: clock.now });
    const session = newSession();

    await fillMinute(app, token);
    clock.advance(10_000);
    const refused = await post(app, { token, body: event(session, "PostToolUse") });
    const otherSession = newSession();
    const otherTeam = await post(app, {
      token: other.token,
      body: event(otherSession, "SessionStart"),
    });
    const whileRefused = await tables(team);
    clock.advance(50_000);
    const next = await post(app, { token, body: event(session, "PostToolUse") });
    flush();

    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("50");
    expect(whileRefused).toEqual(nothingStored);
    expect(otherTeam.status).toBe(204);
    expect((await tables(other.team)).sessions.map((row) => row.session_id)).toEqual([
      otherSession,
    ]);
    expect(next.status).toBe(204);
    const { sessions, events } = await tables(team);
    expect(sessions.map((row) => [row.session_id, row.refused_events])).toEqual([[session, 1]]);
    expect(events).toHaveLength(1);
  });

  it("counts a refused event on its session only when it's one the endpoint stores", async () => {
    const { team, token } = await teamWithToken();
    const clock = fakeClock();
    const { app, flush } = eventsApp({ now: clock.now });
    const session = newSession();

    await fillMinute(app, token);
    const refused = [
      await post(app, { token, body: event(session, "PreToolUse") }),
      await post(app, { token, body: { session_id: session } }),
      await post(app, { token, body: event(session, "SessionStart") }),
    ];
    clock.advance(MINUTE_MS);
    const next = await post(app, { token, body: event(session, "PostToolUse") });
    flush();

    expect(refused.map((res) => res.status)).toEqual([429, 429, 429]);
    expect(next.status).toBe(204);
    const { sessions } = await tables(team);
    expect(sessions.map((row) => [row.session_id, row.refused_events])).toEqual([[session, 1]]);
  });
});

describe("POST /api/hook/events: the size limit (threat H6)", () => {
  /** A JSON event `size` bytes long. */
  const sized = (session: string, size: number) => {
    const head = JSON.stringify(event(session, "PostToolUse", { pad: "" }));
    return head.replace('"pad":""', `"pad":"${"x".repeat(size - head.length)}"`);
  };

  it("answers 413 and stores nothing for a body over 1 MiB that says its Content-Length", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const body = sized(newSession(), HOOK_BODY_LIMIT_BYTES + 1);

    const res = await post(app, {
      token,
      body,
      headers: { "Content-Length": String(Buffer.byteLength(body)) },
    });
    flush();

    expect(res.status).toBe(413);
    expect(await tables(team)).toEqual(nothingStored);
  });

  it("answers 413 and stores nothing for a body over 1 MiB sent chunked, reading no further than the limit", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const chunk = new Uint8Array(64 * 1024).fill("x".charCodeAt(0));
    let pulled = 0;
    // Ten MiB on offer, one chunk at a time.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= 10 * HOOK_BODY_LIMIT_BYTES) return controller.close();
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );

    const res = await post(app, { token, body: stream });
    flush();

    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(HOOK_BODY_LIMIT_BYTES + 2 * chunk.length);
    expect(await tables(team)).toEqual(nothingStored);
  });

  it("stores a body of exactly 1 MiB", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();

    const res = await post(app, { token, body: sized(session, HOOK_BODY_LIMIT_BYTES) });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).sessions.map((row) => row.session_id)).toEqual([session]);
  });
});

describe("POST /api/hook/events: the pseudonym key", () => {
  it("answers 503 and stores nothing when no key is given", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp({ pseudonymKey: null });

    const res = await post(app, { token, body: event(newSession(), "SessionStart") });
    flush();

    expect(res.status).toBe(503);
    expect(JSON.parse(res.text)).toEqual({ error: "The hook isn't set up here" });
    expect(await tables(team)).toEqual(nothingStored);
  });
});

describe("POST /api/hook/events: the shape", () => {
  it.each([
    ["no body", null],
    ["a body that isn't JSON", `not json ${PLANTED}`],
    ["a JSON array", [event("abc", "SessionStart")]],
    ["no session_id", { hook_event_name: "SessionStart", note: PLANTED }],
    ["a session_id holding /", event("abc/def", "SessionStart")],
    ["a session_id over 128 characters", event("a".repeat(129), "SessionStart")],
    ["a hook_event_name that isn't a string", { session_id: "abc", hook_event_name: 7 }],
  ])("answers 400 and stores nothing for %s, echoing none of it", async (_name, body) => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, { token, body });
    flush();

    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({ error: expect.any(String) });
    expect(res.text).not.toContain(PLANTED);
    expect(await tables(team)).toEqual(nothingStored);
  });

  it("answers 204 and stores nothing for an event the block doesn't send: PreToolUse", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, { token, body: event(newSession(), "PreToolUse") });
    flush();

    expect(res).toEqual({ status: 204, retryAfter: null, text: "" });
    expect(await tables(team)).toEqual(nothingStored);
  });

  // Which events the block sends is managed-settings.test.ts's; this one is sent at the content tier only.
  it("stores a UserPromptSubmit event", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, { token, body: event(newSession(), "UserPromptSubmit") });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).events.map((row) => row.name)).toEqual(["UserPromptSubmit"]);
  });
});

/** The secrets the tier cases plant, each in a field only some tiers keep. */
const PLANTED_SECRETS = [AWS_KEY, GITHUB_TOKEN, ANTHROPIC_KEY, STRIPE_KEY];

describe("POST /api/hook/events: each tier's fields, redacted on arrival (story 8; threat H8)", () => {
  const metadata = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_01ABC",
  };
  const details = {
    ...metadata,
    cwd: "~/app",
    transcript_path: "~/.claude/projects/~/s.jsonl",
    tool_input: {
      command: `cd ~/app && AWS_ACCESS_KEY_ID=${mask(AWS_KEY)} gh auth login --with-token ${mask(GITHUB_TOKEN)}`,
    },
  };
  const content = {
    ...details,
    tool_response: { stdout: `${PLANTED} ANTHROPIC_API_KEY=${mask(ANTHROPIC_KEY)}` },
  };

  it.each([
    ["metadata", metadata],
    ["details", details],
    ["content", content],
  ] as const)("stores a Bash PostToolUse's %s fields, redacted", async (tier, stored) => {
    const { team, token } = await teamWithToken(tier);
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token,
      headers: { "X-Warden-Developer": "alice" },
      body: event(newSession(), "PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "toolu_01ABC",
        cwd: "/home/alice/app",
        transcript_path: "/home/alice/.claude/projects/-home-alice-app/s.jsonl",
        tool_input: {
          command: `cd /home/alice/app && AWS_ACCESS_KEY_ID=${AWS_KEY} gh auth login --with-token ${GITHUB_TOKEN}`,
        },
        tool_response: { stdout: `${PLANTED} ANTHROPIC_API_KEY=${ANTHROPIC_KEY}` },
        something_new: `alice ${PLANTED}`,
      }),
    });
    flush();

    expect(res.status).toBe(204);
    const { events } = await tables(team);
    expect(events.map((row) => [row.name, row.tool, row.fields])).toEqual([
      ["PostToolUse", "Bash", stored],
    ]);
    const text = await tablesAsText(team);
    for (const kept of ["alice", ...PLANTED_SECRETS]) expect(text).not.toContain(kept);
    if (tier === "content") expect(text).toContain(PLANTED);
    else expect(text).not.toContain(PLANTED);
  });

  it.each([
    ["metadata", { hook_event_name: "UserPromptSubmit" }],
    ["details", { hook_event_name: "UserPromptSubmit" }],
    ["content", { hook_event_name: "UserPromptSubmit", prompt: `deploy with ${mask(STRIPE_KEY)}` }],
  ] as const)("stores a UserPromptSubmit's prompt only at content: %s", async (tier, stored) => {
    const { team, token } = await teamWithToken(tier);
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token,
      body: event(newSession(), "UserPromptSubmit", { prompt: `deploy with ${STRIPE_KEY}` }),
    });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).events.map((row) => row.fields)).toEqual([stored]);
    expect(await tablesAsText(team)).not.toContain(STRIPE_KEY);
  });

  it.each([
    ["metadata", undefined],
    ["details", undefined],
    ["content", `fatal: ~/app: bad credentials ${mask(GITHUB_TOKEN)}`],
  ] as const)("stores a PostToolUseFailure's error only at content: %s", async (tier, error) => {
    const { team, token } = await teamWithToken(tier);
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token,
      headers: { "X-Warden-Developer": "alice" },
      body: event(newSession(), "PostToolUseFailure", {
        tool_name: "Bash",
        error: `fatal: /home/alice/app: bad credentials ${GITHUB_TOKEN}`,
      }),
    });
    flush();

    expect(res.status).toBe(204);
    const [stored] = (await tables(team)).events;
    expect(stored?.fields.error).toEqual(error);
    const text = await tablesAsText(team);
    expect(text).not.toContain("alice");
    expect(text).not.toContain(GITHUB_TOKEN);
  });

  it("stores a tool_response holding a NUL and a lone surrogate, in a nested string and a key, with U+FFFD", async () => {
    const { team, token } = await teamWithToken("content");
    const { app, flush } = eventsApp();

    const res = await post(app, {
      token,
      body: event(newSession(), "PostToolUse", {
        tool_name: "Bash",
        tool_response: {
          stdout: "fine",
          nested: [{ text: "a\u0000b\ud800c" }],
          ["key\u0000\udc00"]: "value",
        },
      }),
    });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).events.map((row) => row.fields.tool_response)).toEqual([
      { stdout: "fine", nested: [{ text: "a�b�c" }], ["key��"]: "value" },
    ]);
  });
});

describe("POST /api/hook/events: the Agent session record", () => {
  it("stores one session per session_id, with the developer's pseudonym, its agent, start and end", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();
    const send = (name: string, headers: Record<string, string> = {}) =>
      post(app, { token, body: event(session, name), headers });

    await send("SessionStart", { "X-Warden-Developer": "alice" });
    await send("PostToolUse", { "X-Warden-Developer": "alice" });
    const open = await tables(team);
    // A later event naming someone else doesn't change the session's developer.
    await send("SessionEnd", { "X-Warden-Developer": "bob" });
    flush();

    expect(open.sessions.map((row) => row.ended_at)).toEqual([null]);
    const { sessions, events } = await tables(team);
    expect(sessions).toEqual([
      expect.objectContaining({
        session_id: session,
        developer: pseudonym(PSEUDONYM_KEY, team, "alice"),
        agent: "claude-code",
        started_at: expect.any(Date),
        last_event_at: expect.any(Date),
        ended_at: expect.any(Date),
        judged_at: null,
        outcome: null,
        refused_events: 0,
      }),
    ]);
    expect(events.map((row) => row.name)).toEqual(["SessionStart", "PostToolUse", "SessionEnd"]);
  });

  it.each([
    ["no X-Warden-Developer", {}],
    ["an empty one", { "X-Warden-Developer": "" }],
    ["the literal $USER", { "X-Warden-Developer": "$USER" }],
  ])("stores a null developer for %s", async (_name, headers: Record<string, string>) => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();

    const res = await post(app, { token, body: event(newSession(), "SessionStart"), headers });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).sessions.map((row) => row.developer)).toEqual([null]);
  });

  it("stores one session row and two event rows for two first events of a new session sent at once", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();

    const answers = await Promise.all([
      post(app, { token, body: event(session, "SessionStart") }),
      post(app, { token, body: event(session, "PostToolUse") }),
    ]);
    flush();

    expect(answers.map((res) => res.status)).toEqual([204, 204]);
    const { sessions, events } = await tables(team);
    expect(sessions).toHaveLength(1);
    expect(events).toHaveLength(2);
  });
});

describe("POST /api/hook/events: a SessionEnd starts the Judge (story 9, #444)", () => {
  it("starts it once, with the session's id and the token's Team, though the body names another Team", async () => {
    const a = await teamWithToken();
    const b = await teamWithToken();
    const judge = fakeJudge();
    const { app, flush } = eventsApp({ startJudgeJob: judge.start });
    const session = newSession();

    const res = await post(app, {
      token: b.token,
      body: event(session, "SessionEnd", { team: a.team, team_id: a.team }),
      headers: { "X-Warden-Team": a.team },
    });
    flush();

    expect(res.status).toBe(204);
    expect(judge.calls).toEqual([{ sessionId: session, team: b.team }]);
  });

  it("starts nothing for a stored PostToolUse, a PreToolUse, or a SessionEnd over the Team's limit", async () => {
    const { team, token } = await teamWithToken();
    const judge = fakeJudge();
    const clock = fakeClock();
    const { app, flush } = eventsApp({ startJudgeJob: judge.start, now: clock.now });
    const session = newSession();

    const stored = await post(app, { token, body: event(session, "PostToolUse") });
    const skipped = await post(app, { token, body: event(session, "PreToolUse") });
    clock.advance(MINUTE_MS);
    await fillMinute(app, token);
    const limited = await post(app, { token, body: event(session, "SessionEnd") });
    flush();

    expect([stored.status, skipped.status, limited.status]).toEqual([204, 204, 429]);
    expect(judge.calls).toEqual([]);
    expect((await tables(team)).sessions.map((row) => row.ended_at)).toEqual([null]);
  });

  it("still answers 204 when the start throws, the session ended, with one line of its own: the Team and the error", async () => {
    const { team, token } = await teamWithToken();
    const judge = fakeJudge(new Error("The Judge run's jobs.run answered HTTP 503"));
    const { app, lines, ownLines, flush } = eventsApp({ startJudgeJob: judge.start });
    const session = newSession();

    const res = await post(app, {
      token,
      body: event(session, "SessionEnd", { reason: PLANTED }),
      headers: { "X-Warden-Developer": "alice" },
    });
    flush();

    expect(res).toEqual({ status: 204, retryAfter: null, text: "" });
    expect(judge.calls).toHaveLength(1);
    expect((await tables(team)).sessions).toEqual([
      expect.objectContaining({ session_id: session, ended_at: expect.any(Date) }),
    ]);
    expect(ownLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        severity: "WARNING",
        team,
        error: expect.objectContaining({ message: "The Judge run's jobs.run answered HTTP 503" }),
      }),
    ]);
    for (const line of [...lines, ...ownLines]) {
      for (const kept of [
        session,
        PLANTED,
        token,
        "alice",
        pseudonym(PSEUDONYM_KEY, team, "alice"),
      ]) {
        expect(line).not.toContain(kept);
      }
    }
  });

  it("stores a SessionEnd and answers 204 with no Judge starter wired", async () => {
    const { team, token } = await teamWithToken();
    const { app, flush } = eventsApp();
    const session = newSession();

    const res = await post(app, { token, body: event(session, "SessionEnd") });
    flush();

    expect(res.status).toBe(204);
    expect((await tables(team)).sessions).toEqual([
      expect.objectContaining({ session_id: session, ended_at: expect.any(Date) }),
    ]);
  });
});

describe("POST /api/hook/events: the logs (threat H7)", () => {
  it("writes no line of its own when the Judge starts, and no line holds a body, the token, the developer or a pseudonym", async () => {
    const { team, token } = await teamWithToken();
    const { app, lines, ownLines, flush } = eventsApp({ startJudgeJob: fakeJudge().start });
    const body = event(newSession(), "PostToolUse", { note: PLANTED, cwd: "/home/alice" });
    const headers = { "X-Warden-Developer": "alice" };
    await post(app, { token, body, headers });
    await post(app, { token, body: { ...body, hook_event_name: "SessionEnd" }, headers });
    await post(app, { token, body: `{${PLANTED}`, headers });
    await post(app, { token: `${token}x`, body, headers });
    await post(app, { token: null, body, path: `${HOOK_EVENTS_PATH}?token=${token}` });
    const unset = eventsApp({ pseudonymKey: null });
    await post(unset.app, { token, body, headers });
    flush();
    unset.flush();

    expect(ownLines).toEqual([]);
    expect([...lines, ...unset.lines].map((line) => JSON.parse(line).message)).toEqual(
      Array(6).fill("request"),
    );
    // Every line any case in this file wrote.
    expect(allLines.length).toBeGreaterThan(lines.length);
    for (const line of allLines) {
      for (const secret of [
        PLANTED,
        ...PLANTED_SECRETS,
        token,
        "alice",
        pseudonym(PSEUDONYM_KEY, team, "alice"),
      ]) {
        expect(line).not.toContain(secret);
      }
    }
  });
});
