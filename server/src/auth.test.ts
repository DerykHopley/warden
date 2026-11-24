import { beforeAll, describe, expect, it } from "vitest";
import type { CryptoKey } from "jose";
import { createClerkVerifier } from "./auth.ts";
import { sessionToken, testKey } from "../test/helpers.ts";
import { closedPort } from "../test/ports.ts";

let key: CryptoKey;
beforeAll(async () => {
  ({ privateKey: key } = await testKey());
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
