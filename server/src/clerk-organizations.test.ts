import { ClerkAPIResponseError } from "@clerk/backend/errors";
import { describe, expect, it } from "vitest";
import { clerkOrganizations } from "./clerk-organizations.ts";

const change = { organizationId: "org_1", userId: "user_1", role: "org:member" } as const;

const failingWith = (status: number) => ({
  updateOrganizationMembership: async () => {
    throw new ClerkAPIResponseError("Clerk refused", { data: [], status });
  },
});

describe("clerkOrganizations", () => {
  it("passes the change to Clerk's updateOrganizationMembership and answers set", async () => {
    const sent: unknown[] = [];
    const seam = clerkOrganizations({
      updateOrganizationMembership: async (params) => {
        sent.push(params);
        return {};
      },
    });

    expect(await seam.setMembershipRole(change)).toBe("set");
    expect(sent).toEqual([change]);
  });

  it("answers not_a_member when Clerk has no such membership (404)", async () => {
    expect(await clerkOrganizations(failingWith(404)).setMembershipRole(change)).toBe(
      "not_a_member",
    );
  });

  it.each([422, 500])("throws Clerk's %i", async (status) => {
    await expect(clerkOrganizations(failingWith(status)).setMembershipRole(change)).rejects.toThrow(
      ClerkAPIResponseError,
    );
  });
});
