// Valid inputs the tests start from and change one field at a time. Plain objects, so a test can break any of them.

export const repo = { kind: "repo", ref: "https://github.com/example/app" };
export const product = { kind: "product", ref: "shop" };
export const device = { kind: "device", ref: "laptop-17" };
export const agentSession = { kind: "agent_session", ref: "session-7f3a" };

export const fileLocation = { kind: "file", path: ".claude/settings.json", line: 3 };
export const dependencyLocation = {
  kind: "dependency",
  package: "lodash",
  version: "4.17.20",
  vulnerability: "CVE-2021-23337",
};
export const settingLocation = { kind: "setting", name: "disk_encryption" };
export const sessionLocation = { kind: "session" };

export function maskedEvent(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    seq,
    at: "2026-11-24T09:15:02Z",
    name: "PreToolUse",
    tool: "Bash",
    text: `step ${seq}`,
    ...overrides,
  };
}

export function sessionEvidence(overrides: Record<string, unknown> = {}) {
  return {
    events: [maskedEvent(2), maskedEvent(5)],
    events_read: 9,
    events_hash: `sha256:${"ab".repeat(32)}`,
    ...overrides,
  };
}

/** A valid Open Guard Finding on a Repo; pass fields to change it. */
export function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "f-1",
    team: "team-a",
    asset: repo,
    module: "guard",
    rule_id: "guard/agent-can-read-env",
    fingerprint: "guard/agent-can-read-env|file:.claude/settings.json",
    location: fileLocation,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "scan-0",
    last_seen_scan: "scan-0",
    moved_to: null,
    ...overrides,
  };
}

/** One valid Finding for each Asset kind, each with the Location kind it pairs with. */
export const findingOfEachAssetKind = {
  repo: finding(),
  product: finding({
    asset: product,
    module: "patch",
    rule_id: "patch/known-vulnerability",
    location: dependencyLocation,
    fingerprint: "patch/known-vulnerability|dependency:lodash|CVE-2021-23337",
    evidence: { summary: "lodash 4.17.20 is affected by CVE-2021-23337" },
  }),
  device: finding({
    asset: device,
    rule_id: "guard/disk-not-encrypted",
    location: settingLocation,
    fingerprint: "guard/disk-not-encrypted|setting:disk_encryption",
    evidence: { summary: "FileVault is off" },
  }),
  agent_session: finding({
    asset: agentSession,
    rule_id: "guard/agent-read-secret-file",
    location: sessionLocation,
    fingerprint: "guard/agent-read-secret-file|session",
    evidence: { summary: "The agent printed .env", session: sessionEvidence() },
  }),
};

/** A valid Observation on a Repo; pass fields to change it. */
export function observation(overrides: Record<string, unknown> = {}) {
  return {
    asset: repo,
    rule_id: "guard/agent-can-read-env",
    location: fileLocation,
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    ...overrides,
  };
}

export function sessionObservation(overrides: Record<string, unknown> = {}) {
  return observation({
    asset: agentSession,
    rule_id: "guard/agent-read-secret-file",
    location: sessionLocation,
    evidence: { summary: "The agent printed .env", session: sessionEvidence() },
    ...overrides,
  });
}

/** A valid Guard Scan covering one Repo and one Rule, seeing one problem. */
export function scan(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    team: "team-a",
    module: "guard",
    started_at: "2026-11-24T09:00:00Z",
    assets: [repo],
    rules: ["guard/agent-can-read-env"],
    observations: [observation()],
    ...overrides,
  };
}

export const lead = { kind: "person", id: "lead-1" };

/** A valid reconcile case: a Scan opens a labelled Finding beside one from `given`, and a person accepts the new one. */
export function validCase(overrides: Record<string, unknown> = {}) {
  const moved = observation({ location: { kind: "file", path: ".claude/settings.local.json" } });
  return {
    name: "A valid case",
    rule: "A Scan marks a Finding Fixed only if it covered that Asset with that Rule and didn't see the problem.",
    given: { now: "2026-11-24T08:00:00Z", findings: [finding()] },
    steps: [
      { step: "scan", scan: scan({ observations: [moved] }), labels: { moved: 0 } },
      {
        step: "decision",
        decision: "accept",
        finding: { new: "moved" },
        actor: lead,
        reason: "Local settings are never committed",
        until: "2027-01-01T00:00:00Z",
      },
      { step: "expire", now: "2026-12-01T03:00:00Z" },
    ],
    expect: [
      { id: "f-1", status: "fixed", unconfirmed_fix: { candidates: [{ new: "moved" }] } },
      { new: "moved", status: "accepted", moved_to: null },
    ],
    ...overrides,
  };
}

export function spotRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "spot-1",
    team: "team-a",
    module: "guard",
    started_at: "2026-11-24T09:00:00Z",
    observations: [sessionObservation()],
    ...overrides,
  };
}
