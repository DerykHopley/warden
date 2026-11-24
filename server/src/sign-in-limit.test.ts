import { describe, expect, it } from "vitest";
import { clientAddress, createSignInLimit } from "./sign-in-limit.ts";

/** A clock the test moves by hand, in milliseconds. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("the sign-in limit", () => {
  it("lets 20 failures through, then holds the address back from the 21st, with seconds to wait", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });

    for (let failure = 1; failure <= 20; failure++) {
      expect(limit.retryAfter("203.0.113.7")).toBeUndefined();
      limit.failed("203.0.113.7");
      clock.advance(1000);
    }

    // 20 seconds into the minute that began at the first failure.
    expect(limit.retryAfter("203.0.113.7")).toBe(40);
  });

  it("counts each address on its own", () => {
    const limit = createSignInLimit({ now: fakeClock().now });
    for (let failure = 0; failure < 20; failure++) limit.failed("203.0.113.7");

    expect(limit.retryAfter("203.0.113.7")).toBeGreaterThan(0);
    expect(limit.retryAfter("198.51.100.2")).toBeUndefined();
  });

  it("answers the address again once the minute is up, with a fresh count", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });
    for (let failure = 0; failure < 20; failure++) limit.failed("203.0.113.7");

    clock.advance(59_999);
    expect(limit.retryAfter("203.0.113.7")).toBe(1);
    clock.advance(1);
    expect(limit.retryAfter("203.0.113.7")).toBeUndefined();

    limit.failed("203.0.113.7");
    expect(limit.retryAfter("203.0.113.7")).toBeUndefined();
  });

  it("doesn't hold back an address whose failures are spread over more than a minute", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });

    for (let failure = 0; failure < 40; failure++) {
      expect(limit.retryAfter("203.0.113.7")).toBeUndefined();
      limit.failed("203.0.113.7");
      clock.advance(4000);
    }
  });

  it("forgets addresses whose minute is up, so memory doesn't grow with every address seen", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now, sweepAbove: 3 });
    for (const address of ["a", "b", "c", "d"]) limit.failed(address);
    expect(limit.size()).toBe(4);

    clock.advance(60_000);
    limit.failed("e");

    expect(limit.size()).toBe(1);
  });
});

describe("clientAddress", () => {
  it("on Cloud Run, is the last X-Forwarded-For entry, the one Google's front end appends", () => {
    expect(
      clientAddress({ forwardedFor: "198.51.100.9", socketAddress: "169.254.1.1" }, true),
    ).toBe("198.51.100.9");
  });

  it("on Cloud Run, ignores a forged leading X-Forwarded-For value", () => {
    expect(
      clientAddress(
        { forwardedFor: "1.2.3.4, 10.0.0.1,198.51.100.9", socketAddress: "169.254.1.1" },
        true,
      ),
    ).toBe("198.51.100.9");
  });

  it("off Cloud Run, is the socket's address, whatever X-Forwarded-For says", () => {
    expect(clientAddress({ forwardedFor: "1.2.3.4", socketAddress: "127.0.0.1" }, false)).toBe(
      "127.0.0.1",
    );
  });

  it("is 'unknown' when neither is there, so such requests share one count", () => {
    expect(clientAddress({ forwardedFor: undefined, socketAddress: undefined }, true)).toBe(
      "unknown",
    );
    expect(clientAddress({ forwardedFor: " , ", socketAddress: undefined }, true)).toBe("unknown");
    expect(clientAddress({ forwardedFor: "1.2.3.4", socketAddress: undefined }, false)).toBe(
      "unknown",
    );
  });
});
