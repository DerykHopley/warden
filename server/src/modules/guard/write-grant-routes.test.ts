import { describe, expect, it } from "vitest";
import { holdsWriteAppPermissions } from "./write-grant-routes.ts";

const WRITE_APP = { contents: "write", pull_requests: "write", metadata: "read" };

describe("holdsWriteAppPermissions: the write app's three permissions and nothing else (#224, threat G2)", () => {
  it("accepts exactly contents and pull requests at write, with metadata at read", () => {
    expect(holdsWriteAppPermissions(WRITE_APP)).toBe(true);
  });

  it.each([
    // Fails closed: a token naming no permissions holds none of the three that can be known.
    ["names none", {}],
    ["lacks contents", { pull_requests: "write", metadata: "read" }],
    ["lacks pull requests", { contents: "write", metadata: "read" }],
    ["lacks metadata", { contents: "write", pull_requests: "write" }],
    ["can only read contents", { ...WRITE_APP, contents: "read" }],
    ["can only read pull requests", { ...WRITE_APP, pull_requests: "read" }],
    ["can write metadata", { ...WRITE_APP, metadata: "write" }],
    ["can also write workflows", { ...WRITE_APP, workflows: "write" }],
    ["can also read administration", { ...WRITE_APP, administration: "read" }],
  ])("refuses a token that %s", (_name, permissions) => {
    expect(holdsWriteAppPermissions(permissions)).toBe(false);
  });
});
