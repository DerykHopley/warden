// The production Clerk seam: Clerk's Backend API sets a person's Clerk role in an Organization (ADR 0008).
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import type { ClerkOrganizations, MembershipRoleChange } from "./members.ts";

/** The one call Warden makes, as `createClerkClient(...).organizations` has it. */
type OrganizationApi = {
  updateOrganizationMembership(params: MembershipRoleChange): Promise<unknown>;
};

/**
 * Answers `not_a_member` when Clerk has no such membership (its 404: the person left the Organization, or it's gone),
 * and throws any other refusal.
 */
export function clerkOrganizations(api: OrganizationApi): ClerkOrganizations {
  return {
    setMembershipRole: async (change) => {
      try {
        await api.updateOrganizationMembership(change);
        return "set";
      } catch (error) {
        if (isClerkAPIResponseError(error) && error.status === 404) return "not_a_member";
        throw error;
      }
    },
  };
}
