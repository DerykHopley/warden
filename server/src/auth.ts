// Checks a Clerk session token. With the instance's PEM public key (CLERK_JWT_KEY) it needs no network call;
// without it, Clerk's SDK fetches the instance's keys with the secret key.
import { verifyToken } from "@clerk/backend";
import { TokenVerificationError } from "@clerk/backend/errors";
import { z } from "zod";

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

/** An Organization id that can name a Team row: not blank, no spaces around it (withTeam refuses either). */
const TeamId = z.string().refine((id) => id.trim() !== "" && id.trim() === id);
/** A Clerk role, or none when it's missing or not text: it decides only who may create a Team. */
const ClerkRole = z.string().min(1).optional().catch(undefined);

/** A v2 token (Clerk's current one): `o: { id, rol }`, the role without the `org:` prefix. */
const V2Organization = z.object({ v: z.literal(2), o: z.object({ id: TeamId, rol: ClerkRole }) });
/** A v1 token: `org_id` and `org_role`, the prefix included. */
const V1Organization = z.object({ org_id: TeamId, org_role: ClerkRole });

/** The active Organization in a verified token's claims, or no Team when there's none it could name. */
function teamOf(payload: Record<string, unknown>): Session["team"] {
  if (payload.v === 2) {
    const v2 = V2Organization.safeParse(payload);
    if (!v2.success) return null;
    const { id, rol } = v2.data.o;
    return { id, clerkRole: rol === undefined ? null : `org:${rol}` };
  }
  const v1 = V1Organization.safeParse(payload);
  return v1.success ? { id: v1.data.org_id, clerkRole: v1.data.org_role ?? null } : null;
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
  /** The dashboard origins a token may be made for (its `azp`); a token for any other, or none, is refused. */
  authorizedParties: string[];
  /** Clerk's Backend API; only tests point it elsewhere. */
  apiUrl?: string;
}): VerifySessionToken {
  const { secretKey, jwtKey, authorizedParties, apiUrl } = options;
  return async (token) => {
    try {
      const payload = await verifyToken(token, { secretKey, jwtKey, authorizedParties, apiUrl });
      if (typeof payload.sub !== "string" || payload.sub === "") return null;
      return { userId: payload.sub, team: teamOf(payload) };
    } catch (error) {
      if (error instanceof TokenVerificationError && TOKEN_FAILURES.has(error.reason)) return null;
      throw error;
    }
  };
}
