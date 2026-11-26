import { describe, expect, it } from "vitest";
import { atLeast, Role, startsScans } from "../src/index.ts";

describe("atLeast", () => {
  it("orders the Roles Member < Lead < Admin, each including the one below", () => {
    const pairs = Role.options.flatMap((has) =>
      Role.options.map((needed) => `${has}>=${needed}:${atLeast(has, needed)}`),
    );
    expect(pairs).toEqual([
      "member>=member:true",
      "member>=lead:false",
      "member>=admin:false",
      "lead>=member:true",
      "lead>=lead:true",
      "lead>=admin:false",
      "admin>=member:true",
      "admin>=lead:true",
      "admin>=admin:true",
    ]);
  });
});

describe("startsScans", () => {
  it("lets a Lead or an Admin start a Scan, and no Member or person without a Role", () => {
    expect([...Role.options, null].map((role) => `${role}:${startsScans(role)}`)).toEqual([
      "member:false",
      "lead:true",
      "admin:true",
      "null:false",
    ]);
  });
});
