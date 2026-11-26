import { describe, expect, it } from "vitest";
import { pathId } from "./path-id.ts";

describe("pathId", () => {
  it.each([
    ["alone", "\0"],
    ["first", "\0abc"],
    ["in the middle", "a\0b"],
    ["last", "abc\0"],
  ])("answers no id for a value with a NUL %s", (_where, value) => {
    expect(pathId(value)).toBeUndefined();
  });

  it("answers the value itself when it holds no NUL", () => {
    const id = "6f1c2a4e-0b7d-4c55-9a43-2f8e1d6b9c10";

    expect(pathId(id)).toBe(id);
  });

  it("answers no id for a parameter the route doesn't have", () => {
    expect(pathId(undefined)).toBeUndefined();
  });
});
