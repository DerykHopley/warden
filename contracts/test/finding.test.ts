import { describe, expect, it } from "vitest";
import { Evidence, Finding, MaskedAgentEvent, SessionEvidence } from "../src/index.ts";
import {
  dependencyLocation,
  device,
  fileLocation,
  finding,
  findingOfEachAssetKind,
  maskedEvent,
  product,
  repo,
  sessionEvidence,
  sessionLocation,
  settingLocation,
} from "./fixtures.ts";
import { expectRefused } from "./refused.ts";

describe("Finding", () => {
  it("parses a valid Finding of each Asset kind, each with its Location kind", () => {
    for (const value of Object.values(findingOfEachAssetKind)) {
      expect(Finding.parse(value)).toEqual(value);
    }
  });

  it("parses a dependency Location without a vulnerability and a file Location without a line", () => {
    const noCve = { kind: "dependency", package: "lodash", version: "4.17.20" };
    expect(
      Finding.safeParse(
        finding({
          asset: product,
          module: "patch",
          rule_id: "patch/outdated",
          location: noCve,
          fingerprint: "patch/outdated|dependency:lodash|",
        }),
      ).success,
    ).toBe(true);
    const noLine = { kind: "file", path: ".claude/settings.json" };
    expect(Finding.safeParse(finding({ location: noLine })).success).toBe(true);
  });

  it("refuses an unknown Asset kind", () => {
    expectRefused(Finding, finding({ asset: { kind: "container", ref: "web" } }), "kind");
  });

  it("refuses a session Location on any Asset that isn't an Agent session", () => {
    for (const asset of [repo, product, device]) {
      expectRefused(Finding, finding({ asset, location: sessionLocation }), "location");
    }
  });

  it("refuses an Agent session Asset with any other Location", () => {
    for (const location of [fileLocation, dependencyLocation, settingLocation]) {
      expectRefused(
        Finding,
        {
          ...findingOfEachAssetKind.agent_session,
          location,
          fingerprint: "guard/agent-read-secret-file|session",
        },
        "location",
      );
    }
  });

  it("refuses a rule_id that doesn't start with its module and a slash", () => {
    expectRefused(Finding, finding({ rule_id: "patch/known-vulnerability" }), "rule_id");
    expectRefused(Finding, finding({ rule_id: "agent-can-read-env" }), "rule_id");
    expectRefused(Finding, finding({ rule_id: "guardian/agent-can-read-env" }), "rule_id");
  });

  it("refuses a fingerprint that isn't the one fingerprint() gives for its Rule and Location", () => {
    expectRefused(
      Finding,
      finding({ fingerprint: "guard/agent-can-read-env|file:other.json" }),
      "fingerprint",
    );
  });

  it("refuses an absolute path or a path with a .. part", () => {
    for (const path of [
      "/etc/passwd",
      "\\etc\\passwd",
      "C:/Users/dev/.env",
      "../outside",
      "a/../../b",
      "a\\..\\b",
    ]) {
      expectRefused(Finding, finding({ location: { kind: "file", path } }), "path");
    }
  });

  it("accepts a path with dots that aren't a .. part", () => {
    const location = { kind: "file", path: "config/..hidden/.env..bak" };
    const value = finding({
      location,
      fingerprint: "guard/agent-can-read-env|file:config/..hidden/.env..bak",
    });
    expect(Finding.safeParse(value).success).toBe(true);
  });

  describe("lifecycle fields", () => {
    const accepted = {
      status: "accepted",
      accepted_reason: "Test fixtures only",
      accepted_until: "2027-03-01T00:00:00Z",
    };

    it("parses an Accepted Finding with a reason and an expiry", () => {
      expect(Finding.safeParse(finding(accepted)).success).toBe(true);
    });

    it("refuses an Accepted Finding without a reason or without an expiry", () => {
      expectRefused(Finding, finding({ ...accepted, accepted_reason: null }), "accepted_reason");
      expectRefused(Finding, finding({ ...accepted, accepted_reason: "" }), "accepted_reason");
      expectRefused(Finding, finding({ ...accepted, accepted_until: null }), "accepted_until");
      expectRefused(
        Finding,
        finding({ ...accepted, accepted_until: "next spring" }),
        "accepted_until",
      );
    });

    it("refuses accepted_reason or accepted_until on a Finding that isn't Accepted", () => {
      for (const status of ["open", "fixed", "false_positive"]) {
        expectRefused(
          Finding,
          finding({ status, accepted_reason: "Test fixtures only" }),
          "accepted_reason",
        );
        expectRefused(
          Finding,
          finding({ status, accepted_until: "2027-03-01T00:00:00Z" }),
          "accepted_until",
        );
      }
    });

    it("keeps an Unconfirmed fix only on a Fixed Finding", () => {
      const unconfirmed_fix = { candidates: ["f-2"] };
      expect(Finding.safeParse(finding({ status: "fixed", unconfirmed_fix })).success).toBe(true);
      for (const status of ["open", "false_positive"]) {
        expectRefused(Finding, finding({ status, unconfirmed_fix }), "unconfirmed_fix");
      }
      expectRefused(Finding, finding({ ...accepted, unconfirmed_fix }), "unconfirmed_fix");
    });

    it("refuses an Unconfirmed fix with no candidates", () => {
      expectRefused(
        Finding,
        finding({ status: "fixed", unconfirmed_fix: { candidates: [] } }),
        "candidates",
      );
    });

    it("refuses an unknown Status", () => {
      expectRefused(Finding, finding({ status: "resolved" }), "status");
    });
  });

  it("keeps session evidence only on an Agent session Finding", () => {
    expectRefused(
      Finding,
      { ...findingOfEachAssetKind.agent_session, evidence: { summary: "The agent printed .env" } },
      "session",
    );
    for (const value of [
      findingOfEachAssetKind.repo,
      findingOfEachAssetKind.product,
      findingOfEachAssetKind.device,
    ]) {
      expectRefused(
        Finding,
        { ...value, evidence: { summary: "x", session: sessionEvidence() } },
        "session",
      );
    }
  });

  it("comes back read-only", () => {
    const parsed = Finding.parse(finding());
    expect(Object.isFrozen(parsed)).toBe(true);
    // Never called: the assignment only has to fail `pnpm typecheck`.
    const assign = (value: Finding) => {
      // @ts-expect-error a Finding is read-only (ADR 0005)
      value.status = "fixed";
    };
    expect(assign).toBeTypeOf("function");
  });
});

describe("Evidence", () => {
  const secret = { type: "aws_access_key", path: ".env", line: 4, mask: "AKIA****************" };

  it("keeps a secret's type, path, line and mask", () => {
    expect(Evidence.safeParse({ summary: "An AWS key in .env", secret }).success).toBe(true);
  });

  it("has no field for a secret's value", () => {
    expectRefused(
      Evidence,
      { summary: "x", secret: { ...secret, value: "AKIAABCDEFGHIJKLMNOP" } },
      "value",
    );
    expectRefused(Evidence, { summary: "x", secret, value: "AKIAABCDEFGHIJKLMNOP" }, "value");
  });

  it("refuses a mask that shows 5 or more characters, or hides none", () => {
    expectRefused(
      Evidence,
      { summary: "x", secret: { ...secret, mask: "AKIAB***************" } },
      "mask",
    );
    expectRefused(Evidence, { summary: "x", secret: { ...secret, mask: "A*K*I*A*B" } }, "mask");
    expectRefused(Evidence, { summary: "x", secret: { ...secret, mask: "AKIA" } }, "mask");
    expect(Evidence.safeParse({ summary: "x", secret: { ...secret, mask: "****" } }).success).toBe(
      true,
    );
  });

  it("refuses a missing summary or one over 2,000 characters", () => {
    expectRefused(Evidence, { secret }, "summary");
    expectRefused(Evidence, { summary: "x".repeat(2001) }, "summary");
    expect(Evidence.safeParse({ summary: "x".repeat(2000) }).success).toBe(true);
  });
});

describe("SessionEvidence", () => {
  it("keeps 1 to 50 masked events in strictly increasing seq", () => {
    expect(
      SessionEvidence.safeParse(sessionEvidence({ events: [maskedEvent(0)], events_read: 1 }))
        .success,
    ).toBe(true);
    const fifty = Array.from({ length: 50 }, (_, seq) => maskedEvent(seq));
    expect(
      SessionEvidence.safeParse(sessionEvidence({ events: fifty, events_read: 50 })).success,
    ).toBe(true);
  });

  it("refuses 0 or 51 events", () => {
    expectRefused(SessionEvidence, sessionEvidence({ events: [] }), "events");
    const fiftyOne = Array.from({ length: 51 }, (_, seq) => maskedEvent(seq));
    expectRefused(
      SessionEvidence,
      sessionEvidence({ events: fiftyOne, events_read: 60 }),
      "events",
    );
  });

  it("refuses a repeated or decreasing seq", () => {
    expectRefused(
      SessionEvidence,
      sessionEvidence({ events: [maskedEvent(3), maskedEvent(3)] }),
      "seq",
    );
    expectRefused(
      SessionEvidence,
      sessionEvidence({ events: [maskedEvent(5), maskedEvent(2)] }),
      "seq",
    );
  });

  it("refuses an events_read below the number kept, or not above the last seq", () => {
    expectRefused(
      SessionEvidence,
      sessionEvidence({ events: [maskedEvent(0), maskedEvent(1)], events_read: 1 }),
      "events_read",
    );
    expectRefused(
      SessionEvidence,
      sessionEvidence({ events: [maskedEvent(2), maskedEvent(5)], events_read: 5 }),
      "events_read",
    );
    expect(
      SessionEvidence.safeParse(
        sessionEvidence({ events: [maskedEvent(2), maskedEvent(5)], events_read: 6 }),
      ).success,
    ).toBe(true);
  });

  it("refuses an events_hash that isn't sha256: and 64 lower-case hex digits", () => {
    for (const events_hash of [
      "ab".repeat(32),
      `sha256:${"AB".repeat(32)}`,
      `sha256:${"ab".repeat(31)}`,
      `sha256:${"ab".repeat(33)}`,
      `sha1:${"ab".repeat(32)}`,
      `sha256:${"zz".repeat(32)}`,
    ]) {
      expectRefused(SessionEvidence, sessionEvidence({ events_hash }), "events_hash");
    }
  });

  it("has no other key", () => {
    expectRefused(SessionEvidence, sessionEvidence({ raw_events: [] }), "raw_events");
  });
});

describe("MaskedAgentEvent", () => {
  it("accepts an empty text and an event without a tool", () => {
    expect(MaskedAgentEvent.safeParse(maskedEvent(0, { text: "" })).success).toBe(true);
    expect(MaskedAgentEvent.safeParse(maskedEvent(0, { tool: undefined })).success).toBe(true);
    const parsed = MaskedAgentEvent.parse({
      seq: 0,
      at: "2026-11-24T09:15:02Z",
      name: "Stop",
      text: "",
    });
    expect(parsed).not.toHaveProperty("tool");
  });

  it("has no field for an event's raw content", () => {
    expectRefused(MaskedAgentEvent, maskedEvent(0, { raw: "cat .env → AWS_SECRET=…" }), "raw");
    expectRefused(
      MaskedAgentEvent,
      maskedEvent(0, { content: "cat .env → AWS_SECRET=…" }),
      "content",
    );
  });

  it("refuses a text over 4,000 characters", () => {
    expectRefused(MaskedAgentEvent, maskedEvent(0, { text: "x".repeat(4001) }), "text");
    expect(MaskedAgentEvent.safeParse(maskedEvent(0, { text: "x".repeat(4000) })).success).toBe(
      true,
    );
  });

  it("refuses a negative seq, a bad date-time, and a name or tool out of bounds", () => {
    expectRefused(MaskedAgentEvent, maskedEvent(-1), "seq");
    expectRefused(MaskedAgentEvent, maskedEvent(0, { at: "yesterday" }), "at");
    expectRefused(MaskedAgentEvent, maskedEvent(0, { name: "" }), "name");
    expectRefused(MaskedAgentEvent, maskedEvent(0, { name: "x".repeat(65) }), "name");
    expectRefused(MaskedAgentEvent, maskedEvent(0, { tool: "" }), "tool");
    expectRefused(MaskedAgentEvent, maskedEvent(0, { tool: "x".repeat(129) }), "tool");
  });
});
