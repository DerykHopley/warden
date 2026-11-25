// Stories 1 and 2 (reading) and 8 at the API: every person in a Team reads its Products and Patch's frameworks, and no
// Team reads another's. Through the real app with Patch's routes mounted as the start-up file mounts them, as the
// person each session names, on the suite's shared database with Teams of this file's own.
import { randomUUID } from "node:crypto";
import { FrameworksBody, ProductsBody } from "@warden/contracts";
import type { Hono } from "hono";
import type { CryptoKey } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppEnv } from "../src/app.ts";
import { createProducts } from "../src/modules/patch/products.ts";
import { patchRoutes } from "../src/modules/patch/routes.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import {
  activeOrganization,
  seedProduct,
  seedTeam,
  sessionToken,
  testApp,
  testKey,
} from "./helpers.ts";

const MEMBER = "user_member";
const LEAD = "user_lead";

let key: CryptoKey;
let pool: pg.Pool;
let withTeam: WithTeam;
let app: Hono<AppEnv>;

beforeAll(async () => {
  const { privateKey, publicPem } = await testKey();
  key = privateKey;
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  ({ app } = testApp({
    publicPem,
    withTeam,
    mount: patchRoutes({ products: createProducts({ withTeam }) }),
  }));
});

afterAll(() => pool.end());

async function team() {
  const id = `org_${randomUUID()}`;
  await seedTeam(withTeam, id, [
    [MEMBER, "member"],
    [LEAD, "lead"],
  ]);
  return id;
}

async function get(path: string, as: string, teamId: string) {
  const token = await sessionToken(key, as, 60, activeOrganization(teamId));
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("GET /api/products", () => {
  it("answers a Member and a Lead every Product of the Team, in name order, with its Repo URLs and dependencies", async () => {
    const teamId = await team();
    const zebra = await seedProduct(withTeam, teamId, {
      name: "Zebra",
      dependencies: [
        { framework: "ollama", version: null, usage: "self_hosted", internet_facing: false },
      ],
    });
    const support = await seedProduct(withTeam, teamId, {
      name: "support bot",
      repo_urls: [
        "https://github.com/example/support-bot",
        "https://github.com/example/support-infra",
      ],
      dependencies: [
        { framework: "vllm", version: "0.6.1", usage: "hosted", internet_facing: true },
        { framework: "langchain", version: "0.3.27", usage: "library", internet_facing: true },
      ],
    });

    for (const as of [MEMBER, LEAD]) {
      const { status, body } = await get("/api/products", as, teamId);

      expect(status).toBe(200);
      expect(ProductsBody.parse(body)).toEqual({
        team: teamId,
        products: [
          {
            id: support,
            name: "support bot",
            repo_urls: [
              "https://github.com/example/support-bot",
              "https://github.com/example/support-infra",
            ],
            dependencies: [
              {
                framework: "langchain",
                version: "0.3.27",
                usage: "library",
                internet_facing: true,
              },
              { framework: "vllm", version: "0.6.1", usage: "hosted", internet_facing: true },
            ],
          },
          {
            id: zebra,
            name: "Zebra",
            repo_urls: [],
            dependencies: [
              { framework: "ollama", version: null, usage: "self_hosted", internet_facing: false },
            ],
          },
        ],
      });
    }
  });

  it("answers a Team with no Products an empty list", async () => {
    const teamId = await team();

    const { status, body } = await get("/api/products", MEMBER, teamId);

    expect(status).toBe(200);
    expect(body).toEqual({ team: teamId, products: [] });
  });

  it("never lists another Team's Products", async () => {
    const [a, b] = [await team(), await team()];
    await seedProduct(withTeam, a, {
      name: "Team A's app",
      dependencies: [
        { framework: "gradio", version: "4.0.0", usage: "library", internet_facing: false },
      ],
    });
    const bProduct = await seedProduct(withTeam, b, { name: "Team B's app" });

    const { body } = await get("/api/products", LEAD, b);

    expect(ProductsBody.parse(body).products.map((product) => product.id)).toEqual([bProduct]);
  });
});

describe("GET /api/patch/frameworks", () => {
  it("answers a Member Patch's 12 frameworks", async () => {
    const teamId = await team();

    const { status, body } = await get("/api/patch/frameworks", MEMBER, teamId);

    expect(status).toBe(200);
    const { frameworks } = FrameworksBody.parse(body);
    expect(frameworks).toHaveLength(12);
    expect(frameworks.find((framework) => framework.id === "ollama")).toEqual({
      id: "ollama",
      name: "Ollama",
      purls: ["pkg:golang/github.com/ollama/ollama"],
      coverage: "package",
    });
  });
});
