import { describe, expect, it } from "vitest";
import { clientAddress, createSignInLimit, limitKey } from "./sign-in-limit.ts";

/** A clock the test moves by hand, in milliseconds. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** `count` attempts from `address` that each fail (nothing taken back). */
function fail(limit: ReturnType<typeof createSignInLimit>, address: string, count: number) {
  for (let attempt = 0; attempt < count; attempt++) limit.attempt(address);
}

describe("the sign-in limit", () => {
  it("lets 20 failed attempts through, then holds the address back from the 21st, with seconds to wait", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });

    for (let failure = 1; failure <= 20; failure++) {
      expect(limit.attempt("203.0.113.7")).toBeUndefined();
      clock.advance(1000);
    }

    // 20 seconds into the minute that began at the first attempt.
    expect(limit.attempt("203.0.113.7")).toBe(40);
  });

  it("counts an attempt before its outcome, so 30 at once let only 20 through", () => {
    const limit = createSignInLimit({ now: fakeClock().now });

    const answers = Array.from({ length: 30 }, () => limit.attempt("203.0.113.7"));

    expect(answers.filter((answer) => answer === undefined)).toHaveLength(20);
    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(10);
  });

  it("takes back an attempt whose token was good, so successful sign-ins don't count", () => {
    const limit = createSignInLimit({ now: fakeClock().now });

    for (let request = 0; request < 25; request++) {
      expect(limit.attempt("203.0.113.7")).toBeUndefined();
      limit.takeBack("203.0.113.7");
    }
    fail(limit, "203.0.113.7", 20);

    expect(limit.attempt("203.0.113.7")).toBeGreaterThan(0);
  });

  it("counts each address on its own", () => {
    const limit = createSignInLimit({ now: fakeClock().now });
    fail(limit, "203.0.113.7", 20);

    expect(limit.attempt("203.0.113.7")).toBeGreaterThan(0);
    expect(limit.attempt("198.51.100.2")).toBeUndefined();
  });

  it("answers the address again once the minute is up, with a fresh count", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });
    fail(limit, "203.0.113.7", 20);

    clock.advance(59_999);
    expect(limit.attempt("203.0.113.7")).toBe(1);
    clock.advance(1);
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(limit.attempt("203.0.113.7")).toBeUndefined();
    }
  });

  it("doesn't hold back an address whose failures are spread over more than a minute", () => {
    const clock = fakeClock();
    const limit = createSignInLimit({ now: clock.now });

    for (let failure = 0; failure < 40; failure++) {
      expect(limit.attempt("203.0.113.7")).toBeUndefined();
      clock.advance(4000);
    }
  });

  it("forgets addresses whose minute is up, sweeping at most once a minute", () => {
    const clock = fakeClock(0);
    const limit = createSignInLimit({ now: clock.now });
    clock.advance(1000);
    limit.attempt("a"); // its minute ends at 61s

    clock.advance(59_000); // 60s: a minute since the limit began, so a sweep; a's minute isn't up
    limit.attempt("b");
    expect(limit.size()).toBe(2);

    clock.advance(2000); // 62s: a's minute is up, but the last sweep was 2s ago
    limit.attempt("c");
    expect(limit.size()).toBe(3);

    clock.advance(58_000); // 120s: a minute since the last sweep; a's and b's minutes are up
    limit.attempt("d");
    expect(limit.size()).toBe(2);
  });

  it("holds at most maxAddresses, forgetting the oldest first", () => {
    const limit = createSignInLimit({ now: fakeClock().now, maxAddresses: 3 });
    fail(limit, "a", 20);
    expect(limit.attempt("a")).toBeGreaterThan(0);

    for (const address of ["b", "c", "d"]) limit.attempt(address);

    expect(limit.size()).toBe(3);
    expect(limit.attempt("a")).toBeUndefined();
  });

  it("counts an IPv6 /64 as one address", () => {
    const limit = createSignInLimit({ now: fakeClock().now });
    for (let host = 0; host < 20; host++) limit.attempt(`2001:db8:1:2::${host.toString(16)}`);

    expect(limit.attempt("2001:db8:1:2:ffff:ffff:ffff:1")).toBeGreaterThan(0);
    expect(limit.attempt("2001:db8:1:3::1")).toBeUndefined();
  });
});

describe("limitKey", () => {
  it.each([
    ["an IPv4 address", "203.0.113.7", "203.0.113.7"],
    ["an IPv4 address mapped into IPv6", "::ffff:203.0.113.7", "203.0.113.7"],
    ["an IPv6 address, by its /64", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["a shortened IPv6 address", "2001:DB8:0:0::1", "2001:db8:0:0::/64"],
    ["an IPv6 address with leading zeros", "2001:0db8:0001:0002::1", "2001:db8:1:2::/64"],
    ["an IPv6 address shortened in its prefix", "2001:db8::1", "2001:db8:0:0::/64"],
    ["an IPv6 address with a zone", "fe80::1%eth0", "fe80:0:0:0::/64"],
    ["the loopback", "::1", "0:0:0:0::/64"],
    ["anything else, as it is", "unknown", "unknown"],
  ])("keys %s", (_name, address, key) => {
    expect(limitKey(address)).toBe(key);
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
