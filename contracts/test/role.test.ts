import { describe, expect, it } from "vitest";
import { atLeast, Role } from "../src/index.ts";

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
