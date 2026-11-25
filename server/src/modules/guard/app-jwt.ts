// The GitHub App's JWT, signed in this one place for both the GitHub client (linking, story 1) and the GitHub reader (a
// Scan's per-repo token, story 3), so the two can't drift apart. It throws nothing that carries the JWT.
import { sign, type KeyObject } from "node:crypto";

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The App's JWT (GitHub's "Generating a JSON Web Token"): RS256, issued by the client id 60 s in the past against
 * clock drift, expiring 10 minutes after that, so within the 10 minutes GitHub allows. `key` is the App's RSA private
 * key, as each factory builds it with `createPrivateKey`.
 */
export function signAppJwt(clientId: string, key: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
}
