// The real server process: its configuration check at start-up, staying up when the database is gone, shutting down
// cleanly, the modules it wires in, and wiring the GitHub client when its settings are given.
import { randomUUID } from "node:crypto";
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type pg from "pg";
import { ControlsBody, FindingsBody } from "@warden/contracts";
import { createRepoAssets } from "../src/modules/guard/repo-assets.ts";
import { createWithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  ADMIN,
  gitHubAppKey,
  linkRepos,
  newTeam,
  repoRef,
  seedProduct,
  seedTeam,
  sessionToken,
  testKey,
  testPublishableKey,
} from "./helpers.ts";
import { closedPort } from "./ports.ts";
import { pgConnection, startServer as start, waitForListening } from "./server-process.ts";

/** A server on a spare port with the test Clerk settings, the `database` settings and `extra`, once it's listening. */
async function startWith(database: Record<string, string>, extra: Record<string, string> = {}) {
  const port = await closedPort();
  const server = start({
    CLERK_SECRET_KEY: "clerk-secret-value",
    VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
    ...database,
    PORT: String(port),
    ...extra,
  });
  await waitForListening(server.output);
  return { ...server, port };
}

/** A server whose database refuses connections, listening on a spare port. */
async function startWithoutDatabase() {
  return startWith({
    PGHOST: "127.0.0.1",
    PGPORT: String(await closedPort()),
    PGUSER: "warden",
    PGDATABASE: "warden",
  });
}

describe("start-up", () => {
  it("exits 1 naming a missing required variable", async () => {
    const server = start({
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      PGHOST: "127.0.0.1",
      PGUSER: "warden",
      PGDATABASE: "warden",
    });

    expect(await server.exited).toBe(1);
    const entry = JSON.parse(server.output().trim().split("\n").at(-1) ?? "");
    expect(entry).toMatchObject({ severity: "ERROR", variables: ["CLERK_SECRET_KEY"] });
  });

  it("stays up and answers 503 while the database can't be reached", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);

    expect(res.status).toBe(503);
    expect(server.child.exitCode).toBeNull();
  });

  // The modules' routes are wired in index.ts: an unwired one would answer the API's 404.
  it("mounts Guard's routes: GET /api/repos asks for a sign-in", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos`);

    expect(res.status).toBe(401);
  });

  it("mounts the hook routes: GET /api/hook asks for a sign-in", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/hook`);

    expect(res.status).toBe(401);
  });

  // Vouch's routes read the Catalogue loaded at start-up; a load error would have stopped the server before it listened.
  it("mounts Vouch's routes: GET /api/vouch/catalogues asks for a sign-in", async () => {
    const server = await startWithoutDatabase();

    const res = await fetch(`http://127.0.0.1:${server.port}/api/vouch/catalogues`);

    expect(res.status).toBe(401);
  });

  it("exits 0 on SIGTERM", async () => {
    const server = await startWithoutDatabase();

    server.child.kill("SIGTERM");

    expect(await server.exited).toBe(0);
  });
});

describe("start-up with or without the GitHub app's settings", () => {
  let key: CryptoKey;
  let publicPem: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ privateKey: key, publicPem } = await testKey());
    pool = poolAs("warden_app", inject("testDatabase"));
  });

  afterAll(async () => {
    await pool.end();
  });

  const GITHUB_APP = {
    GITHUB_APP_CLIENT_ID: "Iv23li-the-client-id",
    GITHUB_APP_CLIENT_SECRET: "the-client-secret-value",
    GITHUB_APP_PRIVATE_KEY: gitHubAppKey(),
  };

  /**
   * An Admin's link with an empty body, to a server on the suite's database as warden_app: the route refuses the body
   * (400) when GitHub is set up, before any call to GitHub, and answers 503 when it isn't.
   */
  async function linkStatus(env: Record<string, string>) {
    const server = await startWith(
      {
        PGHOST: process.env.PGHOST ?? "",
        PGPORT: process.env.PGPORT ?? "",
        PGUSER: "warden_app",
        PGDATABASE: inject("testDatabase"),
        ...(process.env.PGPASSWORD ? { PGPASSWORD: process.env.PGPASSWORD } : {}),
      },
      { CLERK_JWT_KEY: publicPem, ...env },
    );
    const team = await newTeam(createWithTeam(pool));
    const token = await sessionToken(key, ADMIN, 60, activeOrganization(team));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/github/installations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.status;
  }

  it("builds the GitHub client when GITHUB_APP_* are set: the link route doesn't answer 503", async () => {
    expect(await linkStatus(GITHUB_APP)).toBe(400);
  });

  it("starts without them, and the link route answers 503", async () => {
    expect(await linkStatus({})).toBe(503);
  });
});

describe("the start-up file's wiring", () => {
  // Vouch's Controls read the Team's Findings and its held Assets through the TeamAssets the start-up file builds from
  // Guard's Repo Assets and Patch's Products.
  it("answers a Member each Control's Rules held on the Team's Repo Asset and Product", async () => {
    const database = inject("testDatabase");
    const pool = poolAs("warden_app", database);
    const withTeam = createWithTeam(pool);
    const team = `org_${randomUUID()}`;
    try {
      await seedTeam(withTeam, team, [["user_member", "member"]]);
      await linkRepos(createRepoAssets({ withTeam }), team, [repoRef("app")]);
      await seedProduct(withTeam, team, { name: "Shop" });
    } finally {
      await pool.end();
    }
    const { privateKey, publicPem } = await testKey();
    const port = await closedPort();
    const server = start({
      CLERK_SECRET_KEY: "clerk-secret-value",
      CLERK_JWT_KEY: publicPem,
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      ...pgConnection(),
      PGUSER: "warden_app",
      PGDATABASE: database,
      PORT: String(port),
    });
    await waitForListening(server.output);
    const token = await sessionToken(privateKey, "user_member", 60, activeOrganization(team));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/vouch/catalogues/vda-isa-2027.1/controls`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    const { controls } = ControlsBody.parse(await res.json());
    const held = new Set(
      controls.flatMap(({ evidence }) =>
        evidence.rules.map(({ asset_kind, assets_held }) => `${asset_kind} ${assets_held}`),
      ),
    );
    expect([...held].sort()).toEqual(["product 1", "repo 1"]);
  });

  // Story 3 end to end: the start-up file gives Patch's routes the Patch Scan, so a saved Product's CVEs are Findings.
  it("answers a Lead's saved Product with its CVE Findings", async () => {
    const database = inject("testDatabase");
    const pool = poolAs("warden_app", database);
    const team = `org_${randomUUID()}`;
    try {
      await seedTeam(createWithTeam(pool), team, [["user_lead", "lead"]]);
    } finally {
      await pool.end();
    }
    const { privateKey, publicPem } = await testKey();
    const port = await closedPort();
    const server = start({
      CLERK_SECRET_KEY: "clerk-secret-value",
      CLERK_JWT_KEY: publicPem,
      VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
      ...pgConnection(),
      PGUSER: "warden_app",
      PGDATABASE: database,
      PORT: String(port),
    });
    await waitForListening(server.output);
    const token = await sessionToken(privateKey, "user_lead", 60, activeOrganization(team));
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });

    const saved = await request("/api/products", {
      method: "POST",
      body: JSON.stringify({
        name: "Chatbot",
        repo_urls: [],
        dependencies: [
          { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: false },
        ],
      }),
    });
    const { findings } = FindingsBody.parse(await (await request("/api/findings")).json());

    expect(saved.status).toBe(201);
    expect(findings.map(({ location }) => location)).toContainEqual({
      kind: "dependency",
      package: "pkg:pypi/langchain",
      version: "0.0.200",
      vulnerability: "CVE-2023-36188",
    });
  });
});
