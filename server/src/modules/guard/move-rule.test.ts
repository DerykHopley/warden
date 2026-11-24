import { fingerprint, type Finding } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { guardMoveRule } from "./move-rule.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  const base = {
    id: "f-1",
    team: "team-a",
    asset: { kind: "repo", ref: "https://github.com/example/app" },
    module: "guard",
    rule_id: "guard/agent-can-read-env",
    location: { kind: "file", path: ".claude/settings.json" },
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-1",
    last_seen_scan: "scan-1",
    moved_to: null,
    ...overrides,
  } as const;
  return { ...base, fingerprint: fingerprint(base.rule_id, base.location) } as Finding;
}

describe("Guard's move rule", () => {
  const fixed = finding({ status: "fixed" });

  it("matches the same Rule on the same Asset at another path", () => {
    const opened = finding({
      id: "f-2",
      location: { kind: "file", path: ".claude/settings.local.json" },
    });
    expect(guardMoveRule(fixed, opened)).toBe(true);
  });

  it("doesn't match another Rule on the same Asset", () => {
    expect(guardMoveRule(fixed, finding({ id: "f-2", rule_id: "guard/mcp-server-unpinned" }))).toBe(
      false,
    );
  });

  it("doesn't match the same Rule on another Asset, or on the same ref of another kind", () => {
    const api = { kind: "repo", ref: "https://github.com/example/api" } as const;
    const product = { kind: "product", ref: "https://github.com/example/app" } as const;
    expect(guardMoveRule(fixed, finding({ id: "f-2", asset: api }))).toBe(false);
    expect(guardMoveRule(fixed, finding({ id: "f-2", asset: product }))).toBe(false);
  });
});
