// Findings as GET /api/findings answers them: each a valid Finding v1, so the page's parse takes them. `demoFindings`
// mirrors the server's demo seed: 11 Findings, 7 Open (2 Critical), 2 Fixed (one an Unconfirmed fix), 1 Accepted and
// 1 False positive, from Guard and Patch, on every Asset kind.
import { fingerprint, type Asset, type Finding, type Location } from "@warden/contracts";

const REPO: Asset = { kind: "repo", ref: "https://github.com/acme/shop-web" };
const DEVICE: Asset = { kind: "device", ref: "ada-laptop" };
const PRODUCT: Asset = { kind: "product", ref: "shop" };
const SESSION: Asset = { kind: "agent_session", ref: "session-demo-7f3a" };

/** A valid Open Guard Finding on a Repo, with `id`; `fields` changes it, and the Fingerprint follows the Location. */
export function finding(id: string, fields: Partial<Finding> = {}): Finding {
  const rule_id = fields.rule_id ?? "guard/agent-can-read-env";
  const location: Location = fields.location ?? { kind: "file", path: ".claude/settings.json" };
  return {
    id,
    team: "org_a",
    asset: REPO,
    module: "guard",
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "demo-guard-1",
    last_seen_scan: "demo-guard-1",
    moved_to: null,
    ...fields,
    rule_id,
    location,
    fingerprint: fingerprint(rule_id, location),
  };
}

const dependency = (pkg: string, version: string, cve: string): Location => ({
  kind: "dependency",
  package: pkg,
  version,
  vulnerability: cve,
});

const vulnerable = (
  id: string,
  pkg: string,
  version: string,
  cve: string,
  fields: Partial<Finding>,
): Finding =>
  finding(id, {
    asset: PRODUCT,
    module: "patch",
    rule_id: "patch/known-vulnerability",
    location: dependency(pkg, version, cve),
    title: `${pkg} ${version} has a known vulnerability`,
    evidence: { summary: `${pkg} ${version} is affected by ${cve}` },
    ...fields,
  });

/** Ids as the server makes them: UUIDs. */
export const ID = {
  secret: "3f2a1b9c-0000-4000-8000-000000000001",
  lodash: "a1c4e7f0-0000-4000-8000-000000000002",
  envLocal: "5b6c7d8e-0000-4000-8000-000000000003",
  printed: "9e8d7c6b-0000-4000-8000-000000000004",
  minimist: "c0ffee00-0000-4000-8000-000000000005",
  disk: "d15c0000-0000-4000-8000-000000000006",
  semver: "5e5e5e5e-0000-4000-8000-000000000007",
  envMoved: "0e0e0e0e-0000-4000-8000-000000000008",
  ws: "77777777-0000-4000-8000-000000000009",
  axios: "a8a8a8a8-0000-4000-8000-00000000000a",
  push: "b1b1b1b1-0000-4000-8000-00000000000b",
};

export const demoFindings: Finding[] = [
  finding(ID.secret, {
    rule_id: "guard/committed-secret",
    location: { kind: "file", path: "config/payments.ts", line: 12 },
    severity: "critical",
    title: "A live Stripe secret key is committed",
    evidence: { summary: "A Stripe live secret key sits in config/payments.ts, line 12" },
  }),
  vulnerable(ID.lodash, "lodash", "4.17.20", "CVE-2021-23337", { severity: "critical" }),
  finding(ID.envLocal, { location: { kind: "file", path: ".claude/settings.local.json" } }),
  finding(ID.printed, {
    asset: SESSION,
    rule_id: "guard/agent-printed-secret",
    location: { kind: "session" },
    title: "The agent printed a secret to the terminal",
    evidence: {
      summary: "The agent ran cat .env and its output held the Stripe key",
      session: {
        events: [{ seq: 3, at: "2026-11-24T10:00:00Z", name: "PreToolUse", text: "cat .env" }],
        events_read: 12,
        events_hash: `sha256:${"ab".repeat(32)}`,
      },
    },
  }),
  vulnerable(ID.minimist, "minimist", "1.2.5", "CVE-2021-44906", { severity: "high" }),
  finding(ID.disk, {
    asset: DEVICE,
    rule_id: "guard/disk-not-encrypted",
    location: { kind: "setting", name: "disk_encryption" },
    severity: "medium",
    title: "The disk isn't encrypted",
    evidence: { summary: "FileVault is off on ada-laptop" },
  }),
  vulnerable(ID.semver, "semver", "7.5.1", "CVE-2022-25883", { severity: "low" }),
  finding(ID.envMoved, { status: "fixed", unconfirmed_fix: { candidates: [ID.envLocal] } }),
  vulnerable(ID.ws, "ws", "7.4.5", "CVE-2021-32640", { severity: "high", status: "fixed" }),
  vulnerable(ID.axios, "axios", "0.21.1", "CVE-2021-3749", {
    severity: "medium",
    status: "accepted",
    accepted_reason: "Only called with our own URLs",
    accepted_until: "2027-02-22T12:00:00Z",
  }),
  finding(ID.push, {
    rule_id: "guard/agent-can-push-main",
    severity: "low",
    status: "false_positive",
    title: "The agent may push to main",
    evidence: { summary: "permissions.allow lets the agent run git push origin main" },
  }),
];
