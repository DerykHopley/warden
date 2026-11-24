import { beforeAll, describe, expect, it } from "vitest";
import type { CryptoKey } from "jose";
import { createClerkVerifier } from "./auth.ts";
import { activeOrganization, sessionToken, testKey } from "../test/helpers.ts";
import { closedPort } from "../test/ports.ts";

let key: CryptoKey;
let publicPem: string;
beforeAll(async () => {
  ({ privateKey: key, publicPem } = await testKey());
});

describe("the Session a valid token gives", () => {
  const verify = () => createClerkVerifier({ secretKey: "unused", jwtKey: publicPem });

  it("carries the active Organization of a v2 token as the Team, with Clerk's role prefixed", async () => {
    const token = await sessionToken(key, "user_abc", 60, activeOrganization("org_1", "admin"));
    expect(await verify()(token)).toEqual({
      userId: "user_abc",
      team: { id: "org_1", clerkRole: "org:admin" },
    });
  });

  it("carries the active Organization of a v1 token's org_id and org_role", async () => {
    const token = await sessionToken(key, "user_abc", 60, {
      org_id: "org_1",
      org_role: "org:member",
    });
    expect(await verify()(token)).toEqual({
      userId: "user_abc",
      team: { id: "org_1", clerkRole: "org:member" },
    });
  });

  it("has a Team with no Clerk role when the token's Organization claim has none", async () => {
    const token = await sessionToken(key, "user_abc", 60, { v: 2, o: { id: "org_1" } });
    expect(await verify()(token)).toEqual({
      userId: "user_abc",
      team: { id: "org_1", clerkRole: null },
    });
  });

  it.each([
    ["no Organization claim", {}],
    ["a blank Organization id", { v: 2, o: { id: " ", rol: "admin" } }],
    ["an Organization id with spaces around it", { v: 2, o: { id: " org_1", rol: "admin" } }],
    ["an Organization id that isn't text", { v: 2, o: { id: 7, rol: "admin" } }],
  ])("has no Team with %s", async (_name, claims) => {
    const token = await sessionToken(key, "user_abc", 60, claims);
    expect(await verify()(token)).toEqual({ userId: "user_abc", team: null });
  });
});

// Built at run time, so no secret-shaped literal sits in the repo.
const secretKey = ["sk", "test", "notARealKey"].join("_");

describe("createClerkVerifier without a JWT public key", () => {
  it("throws, rather than calling the person signed out, when Clerk's keys can't be fetched", async () => {
    const verify = createClerkVerifier({
      secretKey,
      jwtKey: undefined,
      apiUrl: `http://127.0.0.1:${await closedPort()}`,
    });
    await expect(verify(await sessionToken(key, "user_abc"))).rejects.toThrow();
  });

  it("still answers null for a token that is itself bad, with no fetch needed", async () => {
    const verify = createClerkVerifier({
      secretKey,
      jwtKey: undefined,
      apiUrl: `http://127.0.0.1:${await closedPort()}`,
    });
    await expect(verify("not-a-jwt")).resolves.toBeNull();
  });
});
