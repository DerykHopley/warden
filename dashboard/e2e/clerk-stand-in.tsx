// WARDEN_E2E_CLERK_STAND_IN: the browser tests' stand-in for @clerk/react. Vite's `e2e` mode (vite.config.ts) puts it
// in place of the package, and only that mode: a production build holds none of it, which a dashboard test checks by
// searching the build for the marker on this file's first line.
//
// A test signs a person in by setting `window.__WARDEN_E2E_SESSION__` before the page loads (Playwright's
// addInitScript): their user id, their active Organization, and a session token the test signed with a key the
// server trusts through CLERK_JWT_KEY. Without it, the person is signed out. Nothing here calls Clerk.
import type { ReactNode } from "react";

export type StandInSession = {
  token: string;
  userId: string;
  orgId: string;
  orgName: string;
  /** The Organization's people as Clerk would list them, for the People page's names. */
  memberships: {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    identifier: string;
  }[];
};

declare global {
  interface Window {
    __WARDEN_E2E_SESSION__?: StandInSession;
  }
}

/** Marks the page as running the stand-in, so a test can tell it isn't talking to Clerk by mistake. */
export const WARDEN_E2E_CLERK_STAND_IN = "WARDEN_E2E_CLERK_STAND_IN";
document.documentElement.dataset.clerk = WARDEN_E2E_CLERK_STAND_IN;

const session = () => window.__WARDEN_E2E_SESSION__;

export function ClerkProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  const signedIn = session();
  return {
    isLoaded: true,
    isSignedIn: signedIn !== undefined,
    sessionId: signedIn === undefined ? null : `sess_${signedIn.userId}`,
    orgId: signedIn?.orgId ?? null,
    getToken: getTokenOf,
    signOut: signOutOf,
  };
}

// Stable functions, as Clerk's are: the pages ask again when getToken changes.
async function getTokenOf(): Promise<string | null> {
  return session()?.token ?? null;
}

async function signOutOf(): Promise<void> {
  delete window.__WARDEN_E2E_SESSION__;
  location.reload();
}

export function useOrganization() {
  const signedIn = session();
  return {
    isLoaded: true,
    organization: signedIn === undefined ? null : { id: signedIn.orgId, name: signedIn.orgName },
    memberships: {
      data: (signedIn?.memberships ?? []).map((publicUserData) => ({ publicUserData })),
    },
  };
}

export function SignIn() {
  return <p>Signed out (the browser tests' stand-in for Clerk's sign-in)</p>;
}

export function OrganizationSwitcher() {
  return <span>{session()?.orgName}</span>;
}

/** Clerk never fails to load here. */
export function ClerkFailed() {
  return null;
}
