// The demo Findings, as data: what the server's demo seed (`pnpm --filter @warden/server seed`) hands to the Findings
// module, and what it leaves. The dashboard's tests build their Findings from the same data, so the two can't drift.
// A subpath (`@warden/contracts/demo`): the dashboard's production bundle never holds it.
import type { Asset, MaskedAgentEvent, Observation, Scan, SpotRun, Status } from "./finding.ts";
import type { ProductInput } from "./products.ts";

const REPO: Asset = { kind: "repo", ref: "https://github.com/acme/shop-web" };
const DEVICE: Asset = { kind: "device", ref: "ada-laptop" };
const PRODUCT: Asset = { kind: "product", ref: "shop" };
const SESSION: Asset = { kind: "agent_session", ref: "session-demo-7f3a" };

const readsEnv = (path: string): Observation => ({
  asset: REPO,
  rule_id: "guard/agent-can-read-env",
  location: { kind: "file", path },
  severity: "high",
  title: "The agent can read .env files",
  evidence: { summary: `permissions.allow in ${path} lets the agent read .env` },
});

const vulnerable = (
  pkg: string,
  version: string,
  vulnerability: string,
  severity: Observation["severity"],
): Observation => ({
  asset: PRODUCT,
  rule_id: "patch/known-vulnerability",
  location: { kind: "dependency", package: pkg, version, vulnerability },
  severity,
  title: `${pkg} ${version} has a known vulnerability`,
  evidence: { summary: `${pkg} ${version} is affected by ${vulnerability}` },
});

/** The redacted events the Judge's Spot run kept; `DEMO_EVENTS_HASH` is their `agentEventsHash()` (a test checks). */
export const DEMO_EVENTS: readonly MaskedAgentEvent[] = [
  { seq: 3, at: "2026-11-24T10:00:00Z", name: "PreToolUse", tool: "Bash", text: "cat .env" },
  {
    seq: 4,
    at: "2026-11-24T10:00:01Z",
    name: "PostToolUse",
    tool: "Bash",
    text: "STRIPE_KEY=****a1b2",
  },
];
export const DEMO_EVENTS_HASH =
  "sha256:6091b34bde6a3f68b55b81e5b3e78d27b83ec77d12ceee68da3601f7dc1ff34d";

/** Every demo Observation, by a short name. */
export const DEMO_OBSERVATIONS = {
  secret: {
    asset: REPO,
    rule_id: "guard/secret-in-repo",
    location: { kind: "file", path: "config/payments.ts", line: 12 },
    severity: "critical",
    title: "A live Stripe secret key is committed",
    evidence: {
      summary: "A Stripe live secret key sits in config/payments.ts, line 12",
      secret: {
        type: "stripe_live_key",
        path: "config/payments.ts",
        line: 12,
        mask: "********a1b2",
      },
    },
  },
  envSettings: readsEnv(".claude/settings.json"),
  envLocal: readsEnv(".claude/settings.local.json"),
  // The Default Pack's broad-Bash-allow Rule. Its place (Asset and location) and the seed's reason for it stay as they
  // were under its older demo Rule id, so a rerun on a Team seeded before still finds the seed's decision.
  push: {
    asset: REPO,
    rule_id: "guard/blanket-bash-allow",
    location: { kind: "file", path: ".claude/settings.json" },
    severity: "low",
    title: "A broad Bash allow gets round the agent's deny rules",
    evidence: {
      summary:
        "permissions.allow in .claude/settings.json holds Bash(*), so the agent can run any command, git push origin main among them",
    },
  },
  disk: {
    asset: DEVICE,
    rule_id: "guard/disk-not-encrypted",
    location: { kind: "setting", name: "disk_encryption" },
    severity: "medium",
    title: "The disk isn't encrypted",
    evidence: { summary: "FileVault is off on ada-laptop" },
  },
  printed: {
    asset: SESSION,
    rule_id: "guard/agent-printed-secret",
    location: { kind: "session" },
    severity: "high",
    title: "The agent printed a secret to the terminal",
    evidence: {
      summary: "The agent ran cat .env and its output held the Stripe key",
      session: { events: DEMO_EVENTS, events_read: 12, events_hash: DEMO_EVENTS_HASH },
    },
  },
  lodash: vulnerable("lodash", "4.17.20", "CVE-2021-23337", "critical"),
  minimist: vulnerable("minimist", "1.2.5", "CVE-2021-44906", "high"),
  axios: vulnerable("axios", "0.21.1", "CVE-2021-3749", "medium"),
  // A long package name with no space in it: the page must wrap it at phone width.
  cognito: vulnerable(
    "@aws-sdk/client-cognito-identity-provider",
    "3.400.0",
    "GHSA-demo-0001",
    "low",
  ),
  ws: vulnerable("ws", "7.4.5", "CVE-2021-32640", "high"),
} satisfies Record<string, Observation>;

export type DemoKey = keyof typeof DEMO_OBSERVATIONS;

/** What the seed leaves on each demo Finding: its Status, and for an Unconfirmed fix, the Finding it may have moved to. */
export const DEMO_OUTCOME: Record<
  DemoKey,
  { status: Status; unconfirmedFixTo?: DemoKey; decidedReason?: string }
> = {
  secret: { status: "open" },
  envSettings: { status: "fixed", unconfirmedFixTo: "envLocal" },
  envLocal: { status: "open" },
  push: {
    status: "false_positive",
    decidedReason: "Demo seed: branch protection refuses the push anyway",
  },
  disk: { status: "open" },
  printed: { status: "open" },
  lodash: { status: "open" },
  minimist: { status: "open" },
  axios: {
    status: "accepted",
    decidedReason: "Demo seed: axios is only called with our own URLs; upgrading next sprint",
  },
  cognito: { status: "open" },
  ws: { status: "fixed" },
};

/**
 * The demo Product the seed creates after the demo Findings, then scans as a save does, so its CVE Findings come from
 * the loaded CVE snapshot. Its one Repo URL is the demo Repo Asset's ref: the Repo's Guard Findings and the Product's
 * CVE Findings name the same code. LangChain 0.0.200 is affected by many CVEs in the 2026-10-13 snapshot. The made-up
 * `shop` Patch Findings above are another Asset, which no Product row holds.
 */
export const DEMO_PRODUCT: ProductInput = {
  name: "Shop web",
  repo_urls: [REPO.ref],
  dependencies: [
    { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: true },
  ],
};

/** How long the demo acceptance lasts from the seed's `now`. */
export const DEMO_ACCEPTED_DAYS = 90;

const GUARD_COVERAGE = {
  module: "guard",
  assets: [REPO, DEVICE],
  rules: [
    "guard/secret-in-repo",
    "guard/agent-can-read-env",
    "guard/blanket-bash-allow",
    "guard/disk-not-encrypted",
  ],
} as const;
const PATCH_COVERAGE = {
  module: "patch",
  assets: [PRODUCT],
  rules: ["patch/known-vulnerability"],
} as const;

/** The ids the seed gives its runs: a Team with any of them has been (or is being) seeded. */
export const DEMO_RUN_IDS = [
  "demo-guard-1",
  "demo-guard-2",
  "demo-patch-1",
  "demo-patch-2",
  "demo-judge-1",
] as const;

/**
 * The seed's runs for `team`, in start order, as of `now`: the second Guard Scan sees the .env rule in another file
 * (the first Finding becomes an Unconfirmed fix); the second Patch Scan no longer sees ws (Fixed); the Judge's Spot run
 * reports the Agent session.
 */
export function demoRuns(team: string, now: Date): { scans: Scan[]; spotRun: SpotRun } {
  const at = (hours: number) => new Date(now.getTime() + hours * 3600_000).toISOString();
  const o = DEMO_OBSERVATIONS;
  const scan = (
    id: string,
    hours: number,
    coverage: typeof GUARD_COVERAGE | typeof PATCH_COVERAGE,
    observations: Observation[],
  ): Scan => ({
    id,
    team,
    started_at: at(hours),
    module: coverage.module,
    assets: [...coverage.assets],
    rules: [...coverage.rules],
    observations,
  });
  return {
    scans: [
      scan("demo-guard-1", -48, GUARD_COVERAGE, [o.secret, o.envSettings, o.push, o.disk]),
      scan("demo-patch-1", -30, PATCH_COVERAGE, [o.lodash, o.minimist, o.axios, o.cognito, o.ws]),
      scan("demo-guard-2", -24, GUARD_COVERAGE, [o.secret, o.envLocal, o.push, o.disk]),
      scan("demo-patch-2", -6, PATCH_COVERAGE, [o.lodash, o.minimist, o.axios, o.cognito]),
    ],
    spotRun: {
      id: "demo-judge-1",
      team,
      module: "guard",
      started_at: at(-2),
      observations: [o.printed],
    },
  };
}
