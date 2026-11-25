// The GitHub App's JWT signer, the one both the GitHub client (linking, story 1) and the GitHub reader (a Scan's
// per-repo token, story 3) sign with.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { gitHubAppKey } from "../../../test/helpers.ts";
import { signAppJwt } from "./app-jwt.ts";

const PRIVATE_KEY = gitHubAppKey();
const CLIENT_ID = "Iv23liTestClientId";

describe("signAppJwt", () => {
  it("makes an RS256 JWT that verifies against the key's public half, issued by the client id for under 10 minutes", async () => {
    const before = Math.floor(Date.now() / 1000);

    const jwt = signAppJwt(CLIENT_ID, createPrivateKey(PRIVATE_KEY));

    const { payload, protectedHeader } = await jwtVerify(jwt, createPublicKey(PRIVATE_KEY), {
      algorithms: ["RS256"],
      issuer: CLIENT_ID,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(protectedHeader).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iat).toBeLessThan(before);
    expect(payload.exp).toBeGreaterThan(after);
    expect(payload.exp! - after).toBeLessThanOrEqual(600);
  });
});
