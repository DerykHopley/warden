// Story 7 at the API: an Admin issues and rotates the Team's hook token (`POST /api/hook/token`), sets its Privacy tier
// (`PUT /api/hook/privacy-tier`), and reads when the token was issued, the tier and the managed-settings block
// (`GET /api/hook`), never the token itself. Through the real app with the hook routes, on the suite's shared
// database, each case with Teams of its own.
import { createHash } from "node:crypto";
import { HookSettingsBody, HookTokenBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { hookRoutes } from "../src/modules/guard/hook-routes.ts";
import { createHookSettings } from "../src/modules/guard/hook-settings.ts";
import { HOOK_EVENTS_PATH, HOOK_TOKEN_PLACEHOLDER } from "../src/modules/guard/managed-settings.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  hookTokenRows,
  newTeam,
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
const MEMBER = "user_member";

/** The app with the hook routes, and every log line it writes. */
function hookApp() {
  const routes = hookRoutes({ hookSettings: createHookSettings({ withTeam }) });
  return testApp({ publicPem, withTeam, moduleRoutes: [routes] });
}

type App = ReturnType<typeof hookApp>["app"];

/** `body` is sent as JSON, or as it is when it's a string; `headers` add to the session's. */
async function call(
  app: App,
  team: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  as = ADMIN,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

async function issue(app: App, team: string, as = ADMIN) {
  const res = await call(app, team, "POST", "/api/hook/token", as);
  return { status: res.status, body: JSON.parse(res.text) as unknown };
}

async function settings(app: App, team: string, as = ADMIN) {
  const res = await call(app, team, "GET", "/api/hook", as);
  return { status: res.status, text: res.text, body: JSON.parse(res.text) as unknown };
}

async function setTier(app: App, team: string, body: unknown, as = ADMIN) {
  const res = await call(app, team, "PUT", "/api/hook/privacy-tier", as, { body });
  return { status: res.status, text: res.text, body: JSON.parse(res.text) as unknown };
}

/** The Team's Privacy tier, as its Admin's `GET /api/hook` reads it. */
async function tierOf(app: App, team: string) {
  return HookSettingsBody.parse((await settings(app, team)).body).privacy_tier;
}

type Hook = { url: string; headers: Record<string, string> };
type Block = { hooks: Record<string, { hooks: Hook[] }[]> };

/** Every hook handler in a managed-settings block. */
const hooksOf = (block: Record<string, unknown>) =>
  Object.values((block as Block).hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

/** The events a managed-settings block sends. */
const eventsOf = (block: Record<string, unknown>) => Object.keys((block as Block).hooks);

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

const rows = (team: string) => hookTokenRows(withTeam, team);

describe("POST /api/hook/token: an Admin issues or rotates the Team's hook token (story 7)", () => {
  it("answers 201 with a token and no previous token for the Team's first", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();

    const res = await issue(app, team);

    expect(res.status).toBe(201);
    expect(HookTokenBody.parse(res.body)).toEqual({
      token: expect.any(String),
      issued_at: expect.any(String),
      previous_valid_until: null,
      managed_settings: expect.any(Object),
    });
  });

  it("answers the managed settings with the new token in every hook's Authorization, at the Team's tier", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    await setTier(app, team, { privacy_tier: "content" });

    const { token, managed_settings } = HookTokenBody.parse((await issue(app, team)).body);

    const hooks = hooksOf(managed_settings);
    expect(hooks).not.toEqual([]);
    for (const hook of hooks) expect(hook.headers.Authorization).toBe(`Bearer ${token}`);
    expect(eventsOf(managed_settings)).toContain("UserPromptSubmit");
  });

  it("stores the token only as its SHA-256 hash: no column of the row holds the token", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();

    const { token } = HookTokenBody.parse((await issue(app, team)).body);

    const [row, ...more] = await rows(team);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ team_id: team, token_hash: sha256(token), issued_by: ADMIN });
    for (const value of Object.values(row ?? {})) expect(String(value)).not.toContain(token);
  });

  it("answers a new token on a rotation, the old one valid until 24 h after the rotation's row", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    const first = HookTokenBody.parse((await issue(app, team)).body);

    const res = await issue(app, team);

    expect(res.status).toBe(201);
    const second = HookTokenBody.parse(res.body);
    expect(second.token).not.toBe(first.token);
    const rotation = (await rows(team))[1]?.issued_at.getTime() ?? NaN;
    const validUntil = Date.parse(second.previous_valid_until ?? "");
    expect(Math.abs(validUntil - (rotation + 24 * 3_600_000))).toBeLessThan(1000);
  });

  it.each([
    ["a Lead", LEAD],
    ["a Member", MEMBER],
  ])("answers %s 403 on both routes, and writes no row", async (_name, as) => {
    const team = await newTeam(withTeam, [
      [ADMIN, "admin"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    const { app } = hookApp();

    expect((await issue(app, team, as)).status).toBe(403);
    expect((await settings(app, team, as)).status).toBe(403);
    expect(await rows(team)).toEqual([]);
  });
});

describe("GET /api/hook: an Admin reads the Team's hook token settings", () => {
  it("answers Team B's Admin no token after Team A issues one", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const { app } = hookApp();
    await issue(app, teamA);

    const res = await settings(app, teamB);

    expect(res.status).toBe(200);
    expect(HookSettingsBody.parse(res.body)).toMatchObject({
      token: null,
      previous_valid_until: null,
    });
  });

  it("answers neither the token nor its hash after a rotation, but the new token's time and the old one's end", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    const first = HookTokenBody.parse((await issue(app, team)).body);
    const second = HookTokenBody.parse((await issue(app, team)).body);

    const res = await settings(app, team);

    expect(res.status).toBe(200);
    const body = HookSettingsBody.parse(res.body);
    expect(body).toMatchObject({
      token: { issued_at: second.issued_at },
      previous_valid_until: second.previous_valid_until,
    });
    expect(second.previous_valid_until).not.toBeNull();
    const hooks = hooksOf(body.managed_settings);
    expect(hooks).not.toEqual([]);
    for (const hook of hooks) {
      expect(hook.headers.Authorization).toBe(`Bearer ${HOOK_TOKEN_PLACEHOLDER}`);
    }
    for (const secret of [first.token, second.token, sha256(first.token), sha256(second.token)]) {
      expect(res.text).not.toContain(secret);
    }
  });

  it.each([
    [
      "https behind a front end that sets X-Forwarded-Proto",
      { "X-Forwarded-Proto": "https" },
      "https",
    ],
    ["the request's own http without it", {}, "http"],
  ])("names the events URL on the request's host, %s", async (_name, headers, scheme) => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();

    const res = await call(app, team, "GET", "http://warden.test:8080/api/hook", ADMIN, {
      headers,
    });

    const { managed_settings } = HookSettingsBody.parse(JSON.parse(res.text));
    const hooks = hooksOf(managed_settings);
    expect(hooks).not.toEqual([]);
    for (const hook of hooks) {
      expect(hook.url).toBe(`${scheme}://warden.test:8080${HOOK_EVENTS_PATH}`);
    }
  });
});

describe("PUT /api/hook/privacy-tier: an Admin sets the Team's Privacy tier (story 7)", () => {
  it("reads details for a Team that never set one, then each tier the Admin sets, the last replacing the one before", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    expect(await tierOf(app, team)).toBe("details");

    const res = await setTier(app, team, { privacy_tier: "content" });

    expect(res.status).toBe(200);
    expect(HookSettingsBody.parse(res.body).privacy_tier).toBe("content");
    expect(await tierOf(app, team)).toBe("content");

    await setTier(app, team, { privacy_tier: "metadata" });

    expect(await tierOf(app, team)).toBe("metadata");
  });

  it("sends the developer's prompts in the block at content only", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    const block = async () =>
      eventsOf(HookSettingsBody.parse((await settings(app, team)).body).managed_settings);

    await setTier(app, team, { privacy_tier: "content" });
    expect(await block()).toContain("UserPromptSubmit");

    await setTier(app, team, { privacy_tier: "metadata" });
    expect(await block()).not.toContain("UserPromptSubmit");
  });

  it.each<[string, unknown, RegExp]>([
    ["a tier outside the three", { privacy_tier: "everything" }, /privacy_tier/],
    ["no tier", {}, /privacy_tier/],
    ["a body that isn't JSON", "privacy_tier=content", /body/],
  ])("answers 400 for %s, naming the field, and stores nothing", async (_name, body, names) => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    await setTier(app, team, { privacy_tier: "content" });

    const res = await setTier(app, team, body);

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(names);
    expect(await tierOf(app, team)).toBe("content");
  });

  it.each([
    ["a Lead", LEAD],
    ["a Member", MEMBER],
  ])("answers %s 403, and the Team's tier stays as it was", async (_name, as) => {
    const team = await newTeam(withTeam, [
      [ADMIN, "admin"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    const { app } = hookApp();
    await setTier(app, team, { privacy_tier: "metadata" });

    expect((await setTier(app, team, { privacy_tier: "content" }, as)).status).toBe(403);

    expect(await tierOf(app, team)).toBe("metadata");
  });

  it("answers Team B's Admin details after Team A sets content", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const { app } = hookApp();

    await setTier(app, teamA, { privacy_tier: "content" });

    expect(await tierOf(app, teamB)).toBe("details");
  });
});

describe("the hook routes' log lines", () => {
  it("hold no token or hash while issuing, rotating, setting the tier or reading the block", async () => {
    const team = await newTeam(withTeam);
    const { app, lines } = hookApp();

    const first = HookTokenBody.parse((await issue(app, team)).body);
    const second = HookTokenBody.parse((await issue(app, team)).body);
    await settings(app, team);
    expect((await setTier(app, team, { privacy_tier: "content" })).status).toBe(200);
    await settings(app, team);

    expect(lines).not.toEqual([]);
    for (const secret of [first.token, second.token, sha256(first.token), sha256(second.token)]) {
      for (const line of lines) expect(line).not.toContain(secret);
    }
  });
});
