// Checks a Clerk session token. With the instance's PEM public key (CLERK_JWT_KEY) it needs no network call;
// without it, Clerk's SDK fetches the instance's keys with the secret key.
import { verifyToken } from "@clerk/backend";
import { TokenVerificationError } from "@clerk/backend/errors";

/**
 * Who a valid session token belongs to: the Clerk user id, and the Team (the active Clerk Organization) with the
 * person's Clerk role in it, `org:admin` or `org:member`, or no Team when the token has no active Organization. The
 * Clerk role only decides who may create a Team; a person's Role comes from Warden's own table (ADR 0008).
 */
export type Session = {
  userId: string;
  team: { id: string; clerkRole: string | null } | null;
};

/**
 * The Session a valid session token gives, or null for a missing, expired or foreign token.
 * Throws when the token can't be checked at all (Clerk's keys can't be fetched, a bad secret key): an outage
 * isn't a reason to sign everyone out.
 */
export type VerifySessionToken = (token: string) => Promise<Session | null>;

/**
 * The active Organization in a verified token's claims. A v2 token (Clerk's current one) has `o: { id, rol }`, its
 * role without the `org:` prefix; a v1 token has `org_id` and `org_role`, prefix included. An id that isn't clean
 * text counts as no Team: it couldn't name a Team row.
 */
function teamOf(payload: Record<string, unknown>): Session["team"] {
  const v2 = payload.v === 2;
  const o = v2 && typeof payload.o === "object" && payload.o !== null ? payload.o : undefined;
  const id = v2 ? (o as { id?: unknown } | undefined)?.id : payload.org_id;
  if (typeof id !== "string" || id.trim() === "" || id.trim() !== id) return null;
  const role = v2 ? (o as { rol?: unknown }).rol : payload.org_role;
  const clerkRole = typeof role !== "string" || role === "" ? null : v2 ? `org:${role}` : role;
  return { id, clerkRole };
}

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
      if (typeof payload.sub !== "string" || payload.sub === "") return null;
      return { userId: payload.sub, team: teamOf(payload) };
    } catch (error) {
      if (error instanceof TokenVerificationError && TOKEN_FAILURES.has(error.reason)) return null;
      throw error;
    }
  };
}
