import { describe, expect, it } from "vitest";
import { createSaveLimit } from "./save-limit.ts";

/** A clock the test moves by hand, in milliseconds. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("the save limit", () => {
  it("by default lets a Team save 30 times a minute, then holds it back with the whole seconds to wait", () => {
    const clock = fakeClock();
    const limit = createSaveLimit({ now: clock.now });

    for (let save = 1; save <= 30; save++) {
      expect(limit.attempt("org_a")).toBeUndefined();
      clock.advance(1000);
    }

    // 30 seconds into the minute that began at the first save.
    expect(limit.attempt("org_a")).toBe(30);
    clock.advance(500);
    expect(limit.attempt("org_a")).toBe(30);
  });

  it("lets the Team save again once its window has passed, with a fresh count", () => {
    const clock = fakeClock();
    const limit = createSaveLimit({ max: 2, windowMs: 10_000, now: clock.now });
    limit.attempt("org_a");
    limit.attempt("org_a");

    clock.advance(9_999);
    expect(limit.attempt("org_a")).toBe(1);
    clock.advance(1);
    expect(limit.attempt("org_a")).toBeUndefined();
    expect(limit.attempt("org_a")).toBeUndefined();
    expect(limit.attempt("org_a")).toBe(10);
  });

  it("counts each Team on its own, Team ids that differ only in case included", () => {
    const limit = createSaveLimit({ max: 1, now: fakeClock().now });
    limit.attempt("org_A");

    expect(limit.attempt("org_A")).toBeGreaterThan(0);
    expect(limit.attempt("org_a")).toBeUndefined();
  });

  it("forgets Teams whose window is over, sweeping at most once a window", () => {
    const clock = fakeClock(0);
    const limit = createSaveLimit({ now: clock.now });
    clock.advance(1000);
    limit.attempt("org_a"); // its minute ends at 61s

    clock.advance(59_000); // 60s: a minute since the limit began, so a sweep; org_a's minute isn't up
    limit.attempt("org_b");
    expect(limit.size()).toBe(2);

    clock.advance(60_000); // 120s: both minutes are up
    limit.attempt("org_c");
    expect(limit.size()).toBe(1);
  });
});
