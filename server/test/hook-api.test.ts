// Story 7 at the API, part one: an Admin issues and rotates the Team's hook token (`POST /api/hook/token`) and reads
// when it was issued (`GET /api/hook`), never the token itself. Through the real app with the hook routes, on the
// suite's shared database, each case with Teams of its own.
import { createHash } from "node:crypto";
import { HookSettingsBody, HookTokenBody } from "@warden/contracts";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { hookRoutes } from "../src/modules/guard/hook-routes.ts";
import { createHookSettings } from "../src/modules/guard/hook-settings.ts";
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

async function call(app: App, team: string, method: "GET" | "POST", path: string, as = ADMIN) {
  const token = await sessionToken(key, as, 60, activeOrganization(team));
  const res = await app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
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
    });
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
    expect(HookSettingsBody.parse(res.body)).toEqual({ token: null, previous_valid_until: null });
  });

  it("answers neither the token nor its hash after a rotation, but the new token's time and the old one's end", async () => {
    const team = await newTeam(withTeam);
    const { app } = hookApp();
    const first = HookTokenBody.parse((await issue(app, team)).body);
    const second = HookTokenBody.parse((await issue(app, team)).body);

    const res = await settings(app, team);

    expect(res.status).toBe(200);
    expect(HookSettingsBody.parse(res.body)).toEqual({
      token: { issued_at: second.issued_at },
      previous_valid_until: second.previous_valid_until,
    });
    expect(second.previous_valid_until).not.toBeNull();
    for (const secret of [first.token, second.token, sha256(first.token), sha256(second.token)]) {
      expect(res.text).not.toContain(secret);
    }
  });
});

describe("the hook routes' log lines", () => {
  it("hold no token or hash while issuing, rotating or reading", async () => {
    const team = await newTeam(withTeam);
    const { app, lines } = hookApp();

    const first = HookTokenBody.parse((await issue(app, team)).body);
    const second = HookTokenBody.parse((await issue(app, team)).body);
    await settings(app, team);

    expect(lines).not.toEqual([]);
    for (const secret of [first.token, second.token, sha256(first.token), sha256(second.token)]) {
      for (const line of lines) expect(line).not.toContain(secret);
    }
  });
});
