import { describe, expect, it } from "vitest";
import { failureMessage } from "./migrate.ts";

describe("failureMessage", () => {
  it("names the failed migration", () => {
    expect(failureMessage({ applied: ["0001_good"], failed: "0002_bad", error: new Error() })).toBe(
      "migration 0002_bad failed; it was rolled back and no later migration was applied",
    );
  });

  it("says nothing ran when the run stopped before any migration", () => {
    expect(failureMessage({ applied: [], error: new Error() })).toBe(
      "migrating failed before any migration ran",
    );
  });

  it("names what was applied when the run stopped between migrations", () => {
    expect(failureMessage({ applied: ["0001_a", "0002_b"], error: new Error() })).toBe(
      "migrating stopped after applying 0001_a, 0002_b; no later migration was applied",
    );
  });
});
