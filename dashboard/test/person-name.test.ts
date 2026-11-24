// How the dashboard names a person, on People and as who asked for a Proposal: their name in Clerk's memberships,
// else their email, else their user id.
import { describe, expect, it } from "vitest";
import { personName } from "../src/person-name.ts";

const clerkUser = (firstName: string | null, lastName: string | null) => ({
  firstName,
  lastName,
  identifier: "grace@acme.test",
});

describe("personName", () => {
  it("is their name in Clerk", () => {
    expect(personName("user_1", clerkUser("Grace", "Hopper"))).toBe("Grace Hopper");
    expect(personName("user_1", clerkUser("Grace", null))).toBe("Grace");
    expect(personName("user_1", clerkUser(null, "Hopper"))).toBe("Hopper");
  });

  it("is their email when Clerk has no name for them", () => {
    expect(personName("user_1", clerkUser(null, null))).toBe("grace@acme.test");
    expect(personName("user_1", clerkUser("  ", ""))).toBe("grace@acme.test");
  });

  it("is their user id when Clerk's memberships don't have them", () => {
    expect(personName("user_1", undefined)).toBe("user_1");
  });
});
