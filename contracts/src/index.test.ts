import { describe, expect, it } from "vitest";
import { HealthBody, MeBody } from "./index.ts";

describe("HealthBody", () => {
  it("accepts a healthy body", () => {
    expect(HealthBody.parse({ status: "ok", database: "ok", vector: "available" })).toEqual({
      status: "ok",
      database: "ok",
      vector: "available",
    });
  });

  it("accepts a body naming the failed part", () => {
    const body = { status: "unavailable", database: "unreachable", vector: "unknown" };
    expect(HealthBody.parse(body)).toEqual(body);
  });

  it("rejects a status it doesn't know", () => {
    expect(
      HealthBody.safeParse({ status: "fine", database: "ok", vector: "available" }).success,
    ).toBe(false);
  });
});

describe("MeBody", () => {
  it("needs a non-empty user id", () => {
    expect(MeBody.parse({ userId: "user_123" })).toEqual({ userId: "user_123" });
    expect(MeBody.safeParse({ userId: "" }).success).toBe(false);
    expect(MeBody.safeParse({}).success).toBe(false);
  });
});
