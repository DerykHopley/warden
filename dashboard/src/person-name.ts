// How the dashboard names a person: one rule for People and for who asked for a Proposal. Names live in Clerk, not
// Warden.
import { useOrganization } from "@clerk/react";

/** A person as Clerk's Organization memberships list them. */
export type ClerkUser = { firstName: string | null; lastName: string | null; identifier: string };

// A Team past this many people shows the rest by email or user id.
const MEMBERSHIPS_PAGE = { pageSize: 100 };

/** The active Organization's people as Clerk lists them, by user id. */
export function useClerkUsers(): Map<string, ClerkUser> {
  const { memberships } = useOrganization({ memberships: MEMBERSHIPS_PAGE });
  return new Map(
    (memberships?.data ?? []).flatMap((m) =>
      m.publicUserData?.userId ? [[m.publicUserData.userId, m.publicUserData] as const] : [],
    ),
  );
}

/** Their name in Clerk, else their email, else (no Clerk membership found) their user id. */
export function personName(userId: string, clerkUser: ClerkUser | undefined): string {
  const fullName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter((part) => part?.trim())
    .join(" ");
  return fullName || clerkUser?.identifier || userId;
}
