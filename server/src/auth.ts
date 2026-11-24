// Checks a Clerk session token. With the instance's PEM public key (CLERK_JWT_KEY) it needs no network call;
// without it, Clerk's SDK fetches the instance's keys with the secret key.
import { verifyToken } from "@clerk/backend";

/** The Clerk user id a valid session token belongs to, or null for a missing, expired or foreign token. */
export type VerifySessionToken = (token: string) => Promise<string | null>;

export function createClerkVerifier(options: {
  secretKey: string;
  jwtKey: string | undefined;
}): VerifySessionToken {
  return async (token) => {
    try {
      const payload = await verifyToken(token, options);
      return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
    } catch {
      return null;
    }
  };
}
