import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";

describe("createLogger", () => {
  it("writes one redacted JSON object per line, with Cloud Logging's severity and message", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1In0", "c2ln"].join(".");

    log.error(`failed with ${jwt}`, { headers: { authorization: `Bearer ${jwt}` } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\n$/);
    expect(lines[0]?.trimEnd()).not.toContain("\n");
    const entry = JSON.parse(lines[0] ?? "");
    expect(entry).toMatchObject({ severity: "ERROR", message: "failed with ***" });
    expect(typeof entry.time).toBe("string");
    expect(lines[0]).not.toContain(jwt);
  });
});
