// Checks a Clerk session token. With the instance's PEM public key (CLERK_JWT_KEY) it needs no network call;
// without it, Clerk's SDK fetches the instance's keys with the secret key.
import { verifyToken } from "@clerk/backend";
import { TokenVerificationError } from "@clerk/backend/errors";

/**
 * The Clerk user id a valid session token belongs to, or null for a missing, expired or foreign token.
 * Throws when the token can't be checked at all (Clerk's keys can't be fetched, a bad secret key): an outage
 * isn't a reason to sign everyone out.
 */
export type VerifySessionToken = (token: string) => Promise<string | null>;

/** The reasons that are about the token itself; any other failure is the server's. */
const TOKEN_FAILURES = new Set<string>([
  "token-expired",
  "token-invalid",
  "token-invalid-algorithm",
  "token-invalid-authorized-parties",
  "token-invalid-issuer",
  "token-invalid-signature",
  "token-not-active-yet",
  "token-iat-in-the-future",
  "token-verification-failed",
  "jwk-kid-mismatch",
  "jwk-remote-missing",
]);

export function createClerkVerifier(options: {
  secretKey: string;
  jwtKey: string | undefined;
  /** Clerk's Backend API; only tests point it elsewhere. */
  apiUrl?: string;
}): VerifySessionToken {
  return async (token) => {
    try {
      const payload = await verifyToken(token, options);
      return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
    } catch (error) {
      if (error instanceof TokenVerificationError && TOKEN_FAILURES.has(error.reason)) return null;
      throw error;
    }
  };
}
