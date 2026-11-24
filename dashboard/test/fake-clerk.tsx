// A stand-in for @clerk/react's hooks and components, so the dashboard's tests drive sign-in, the active
// Organization and its memberships without Clerk. A test file mocks the package with this module and changes `clerk`.
import { vi } from "vitest";

type Membership = {
  publicUserData: {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    identifier: string;
  };
};

export const clerk = {
  auth: {
    isLoaded: true,
    isSignedIn: false as boolean,
    sessionId: null as string | null,
    orgId: null as string | null,
    getToken: async () => "session-token" as string | null,
    signOut: async () => {},
  },
  /** Each Organization's name, by id; the active one is `auth.orgId`. */
  orgNames: {} as Record<string, string>,
  memberships: [] as Membership[],
  /** The props each OrganizationSwitcher was last given. */
  switcherProps: [] as Record<string, unknown>[],
};

export function resetClerk() {
  clerk.auth.isSignedIn = false;
  clerk.auth.sessionId = null;
  clerk.auth.orgId = null;
  clerk.auth.getToken = async () => "session-token";
  clerk.auth.signOut = vi.fn(async () => {});
  clerk.orgNames = {};
  clerk.memberships = [];
  clerk.switcherProps = [];
}

export const useAuth = () => clerk.auth;

export const useOrganization = () => {
  const id = clerk.auth.orgId;
  return {
    isLoaded: true,
    organization: id === null ? null : { id, name: clerk.orgNames[id] ?? id },
    memberships: { data: clerk.memberships },
  };
};

export const SignIn = () => <div>Clerk sign-in</div>;

export const OrganizationSwitcher = (props: Record<string, unknown>) => {
  clerk.switcherProps.push(props);
  return <div>Clerk organization switcher</div>;
};
