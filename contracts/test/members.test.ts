import { describe, expect, it } from "vitest";
import { MembersBody, RoleChangeBody, TeamMember } from "../src/index.ts";
import { expectRefused } from "./refused.ts";

const member = { userId: "user_a", role: "lead", joinedAt: "2026-11-24T10:00:00.000Z" };

describe("MembersBody", () => {
  it("accepts a Team's members", () => {
    expect(MembersBody.parse({ members: [member] })).toEqual({ members: [member] });
  });

  it("refuses a Role outside the three", () => {
    expectRefused(MembersBody, { members: [{ ...member, role: "owner" }] }, "role");
  });

  it("refuses a joinedAt that isn't a timestamp", () => {
    expectRefused(TeamMember, { ...member, joinedAt: "yesterday" }, "joinedAt");
  });
});

describe("RoleChangeBody", () => {
  it("accepts each of the three Roles", () => {
    for (const role of ["member", "lead", "admin"]) {
      expect(RoleChangeBody.parse({ role })).toEqual({ role });
    }
  });

  it.each([
    ["a Role outside the three", { role: "owner" }],
    ["no Role", {}],
  ])("refuses %s", (_name, body) => {
    expectRefused(RoleChangeBody, body, "role");
  });
});
