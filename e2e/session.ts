// Who the browser tests sign in as, and how: a session token shaped like Clerk's, signed with the key the global
// setup made (the server trusts its public half through CLERK_JWT_KEY), handed to the dashboard's Clerk stand-in
// before the page loads.
import { test as base, type Page } from "@playwright/test";
import { importJWK, SignJWT, type JWK } from "jose";

/** The Clerk Frontend API host the test publishable key names. Nothing is ever fetched from it. */
export const FRONTEND_API_HOST = "warden-e2e.clerk.accounts.dev";

export type Person = { userId: string; firstName: string; lastName: string; email: string };

export const ADA: Person = {
  userId: "user_e2e_ada",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@acme.test",
};
export const GRACE: Person = {
  userId: "user_e2e_grace",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@acme.test",
};
export const LINUS: Person = {
  userId: "user_e2e_linus",
  firstName: "Linus",
  lastName: "Bluebird",
  email: "linus@bluebird.test",
};

export const MARGARET: Person = {
  userId: "user_e2e_margaret",
  firstName: "Margaret",
  lastName: "Hamilton",
  email: "margaret@bluebird.test",
};

/**
 * Two Teams, each opened by its Admin and seeded with the demo Findings. Acme also has Grace, a Member; Bluebird has
 * Margaret, a Member (only e2e/decisions.spec.ts reads Bluebird, so its decisions can't touch Acme's tests).
 */
export const ACME = { id: "org_e2e_acme", name: "Acme", admin: ADA, people: [ADA, GRACE] };
export const BLUEBIRD = {
  id: "org_e2e_bluebird",
  name: "Bluebird",
  admin: LINUS,
  people: [LINUS, MARGARET],
};

export type Team = typeof ACME;

/** A v2 session token for `person` in `team`, as Clerk writes one: `o.rol` without the `org:` prefix. */
export async function sessionToken(
  key: CryptoKey | Uint8Array,
  origin: string,
  person: Person,
  team: Team,
  clerkRole: "admin" | "member",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (
    new SignJWT({
      sid: `sess_${person.userId}`,
      azp: origin,
      v: 2,
      o: { id: team.id, rol: clerkRole },
    })
      // `cat` is the category Clerk's SDK puts on a session token's header, and checks (as in the server's tests).
      .setProtectedHeader({ alg: "RS256", kid: "ins_e2e", typ: "JWT", cat: "cl_B7d4PD111AAA" })
      .setSubject(person.userId)
      .setIssuer(`https://${FRONTEND_API_HOST}`)
      .setIssuedAt(now - 60)
      .setNotBefore(now - 60)
      .setExpirationTime(now + 3600)
      .sign(key)
  );
}

/** The signing key the global setup made, from the environment it left for the test workers. */
export async function signingKey() {
  const jwk = process.env.E2E_SIGNING_JWK;
  if (!jwk) throw new Error("E2E_SIGNING_JWK is unset: run the browser tests with `pnpm e2e`");
  return importJWK(JSON.parse(jwk) as JWK, "RS256");
}

/** The browser tests' `test`: `baseURL` is the server the global setup started, and `signIn` signs a person in. */
export const test = base.extend<{
  signIn: (person: Person, team?: Team) => Promise<void>;
}>({
  // Playwright reads a fixture's dependencies from its first parameter's pattern: this one has none.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(process.env.E2E_BASE_URL);
  },
  signIn: async ({ page, baseURL }, use) => {
    await use(async (person, team = ACME) => {
      const origin = new URL(baseURL!).origin;
      const role = person === team.admin ? "admin" : "member";
      const session = {
        token: await sessionToken(await signingKey(), origin, person, team, role),
        userId: person.userId,
        orgId: team.id,
        orgName: team.name,
        memberships: team.people.map((p) => ({
          userId: p.userId,
          firstName: p.firstName,
          lastName: p.lastName,
          identifier: p.email,
        })),
      };
      await signInPage(page, session);
    });
  },
});

function signInPage(page: Page, session: object) {
  return page.addInitScript((value) => {
    (window as unknown as { __WARDEN_E2E_SESSION__: object }).__WARDEN_E2E_SESSION__ = value;
  }, session);
}

export { expect } from "@playwright/test";
