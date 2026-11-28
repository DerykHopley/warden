// The live attack replay (spec #225, slice 10c): `eval:replay` posts the case marked `replay` to a running Warden's
// hook endpoint, as the managed-settings block sends it at the case's tier, under a session of its own. Run as its own
// process against a Warden app with the hook routes on a spare port and the suite's database: no Judge starter, so
// nothing calls a model.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createLogger } from "../../src/log.ts";
import { createAgentSessions, type AgentSessions } from "../../src/modules/guard/agent-sessions.ts";
import { hookEventRoutes } from "../../src/modules/guard/hook-event-routes.ts";
import { createHookSettings, type HookSettings } from "../../src/modules/guard/hook-settings.ts";
import { createWithTeam, type WithTeam } from "../../src/with-team.ts";
import { runCommand } from "../child-process.ts";
import { poolAs } from "../databases.ts";
import { ADMIN, newTeam, testApp, testKey } from "../helpers.ts";
import { AWS_KEY } from "../secret-fixtures.ts";
import { loadEvalCases } from "./eval-cases.ts";
import { hookEventsSentAt } from "./harness.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPLAY = loadEvalCases().find((c) => c.replay)!;

let pool: pg.Pool;
let withTeam: WithTeam;
let hookSettings: HookSettings;
let agentSessions: AgentSessions;
let server: ReturnType<typeof serve>;
let wardenUrl: string;
/** The status of each request the app answered, in order. */
const answered: number[] = [];

beforeAll(async () => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  hookSettings = createHookSettings({ withTeam });
  agentSessions = createAgentSessions({ withTeam });
  const { publicPem } = await testKey();
  const { app } = testApp({
    publicPem,
    withTeam,
    moduleRoutes: [
      hookEventRoutes({
        hookSettings,
        agentSessions,
        pseudonymKey: randomBytes(32),
        behindCloudRun: false,
        logger: createLogger(() => {}),
      }),
    ],
  });
  server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve(
      {
        fetch: async (request, env) => {
          const response = await app.fetch(request, env);
          answered.push(response.status);
          return response;
        },
        port: 0,
        hostname: "127.0.0.1",
      },
      () => resolve(started),
    );
  });
  wardenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

/** A Team at the replay case's tier, with a hook token. */
async function teamWithToken() {
  const team = await newTeam(withTeam);
  const { token } = await hookSettings.issueToken(team, { issuedBy: ADMIN });
  await hookSettings.setPrivacyTier(team, { tier: REPLAY.tier, setBy: ADMIN });
  return { team, token };
}

/** `eval:replay` run as the script runs it, from server/, with `env` over only PATH and HOME. */
const evalReplay = (env: Record<string, string | undefined>) =>
  runCommand([process.execPath, "test/judge-eval/replay.ts"], env, {
    cwd: SERVER_DIR,
    clean: true,
  });

describe("eval:replay: the demo's live attack, posted to a running Warden", () => {
  it("posts every event the case sends at its tier, each answered 204, and the session ends", async () => {
    const { team, token } = await teamWithToken();
    const sent = REPLAY.events.filter((event) =>
      hookEventsSentAt(REPLAY.tier).has(event.hook_event_name),
    );
    const before = answered.length;

    const { code, stdout, stderr } = await evalReplay({
      WARDEN_REPLAY_URL: wardenUrl,
      WARDEN_HOOK_TOKEN: token,
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(answered.slice(before)).toEqual(sent.map(() => 204));
    const sessionId = /session (replay-[0-9a-f-]{36})\n/.exec(stdout)?.[1];
    expect(sessionId).toBeDefined();
    expect(stdout).toContain(`posted ${sent.length} events\n`);
    const record = await agentSessions.record(team, sessionId!);
    expect(record?.endedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["WARDEN_REPLAY_URL", "unset", { WARDEN_REPLAY_URL: undefined }],
    ["WARDEN_REPLAY_URL", "empty", { WARDEN_REPLAY_URL: "" }],
    ["WARDEN_HOOK_TOKEN", "unset", { WARDEN_HOOK_TOKEN: undefined }],
    ["WARDEN_HOOK_TOKEN", "empty", { WARDEN_HOOK_TOKEN: "" }],
    ["WARDEN_REPLAY_URL", "not a URL", { WARDEN_REPLAY_URL: "not a url" }],
    ["WARDEN_REPLAY_URL", "http off localhost", { WARDEN_REPLAY_URL: "http://warden.example" }],
    ["WARDEN_REPLAY_URL", "neither http nor https", { WARDEN_REPLAY_URL: "ftp://127.0.0.1" }],
  ])("exits 2 naming %s when it's %s, before any post", async (variable, _, change) => {
    const before = answered.length;

    const { code, stdout, stderr } = await evalReplay({
      WARDEN_REPLAY_URL: wardenUrl,
      WARDEN_HOOK_TOKEN: "whk_planted-token",
      ...change,
    });

    expect(code).toBe(2);
    expect(stderr).toContain(variable);
    expect(stdout).toBe("");
    expect(answered.length).toBe(before);
  });

  it("stops at event 0 printing 401 for a wrong token, holding neither the token nor the case's secret", async () => {
    const token = `whk_wrong-${randomBytes(8).toString("hex")}`;
    const before = answered.length;

    const { code, output } = await evalReplay({
      WARDEN_REPLAY_URL: wardenUrl,
      WARDEN_HOOK_TOKEN: token,
    });

    expect(code).toBe(1);
    expect(answered.slice(before)).toEqual([401]);
    expect(output).toContain(`event 0 (${REPLAY.events[0]!.hook_event_name}) answered 401`);
    expect(output).not.toContain(token);
    expect(output).not.toContain(AWS_KEY);
  });

  it("stops at event 0 naming a connection error", async () => {
    const closed = serve({ fetch: () => new Response(null), port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => closed.once("listening", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const { code, stderr } = await evalReplay({
      WARDEN_REPLAY_URL: `http://127.0.0.1:${port}`,
      WARDEN_HOOK_TOKEN: "whk_planted-token",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("event 0 (");
    expect(stderr).toContain("ECONNREFUSED");
  });
});
