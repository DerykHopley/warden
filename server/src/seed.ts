// The demo seed: a handful of Findings across modules, Asset kinds, Severities and Statuses in one Team, so local
// development and an owner preview show a filled Findings page. It writes only through the Findings module, as a
// module and a Lead would: Scans through `reconcile`, a Spot run through `report`, and two named decisions made as
// the Team's oldest Admin or Lead. The browser tests seed their Team with it too.
//
// As its own process: `pnpm --filter @warden/server seed <team-id>`, the Team being the Clerk Organization id (`org_…`)
// that the Team's Admin has already opened Warden in. It connects as warden_app (the PG* variables, with the server's
// role check on connect: a role that can get around row-level security exits 1), and leaves a Team that already has
// Findings as it is. Exit 0 when seeded or left as it was; 1 otherwise, naming why.
import {
  agentEventsHash,
  type Asset,
  type MaskedAgentEvent,
  type Observation,
  type RuleId,
} from "@warden/contracts";
import { sql } from "kysely";
import { createPool, guardDatabaseRole } from "./database.ts";
import { createFindings, type Findings } from "./findings/index.ts";
import { createLogger, type Logger } from "./log.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import { createWithTeam, type WithTeam } from "./with-team.ts";

export type SeedResult =
  | { kind: "seeded"; findings: number }
  /** The Team already has Findings: nothing was written. */
  | { kind: "has_findings"; findings: number }
  /** Warden has no such Team: its Admin hasn't opened Warden in it yet. */
  | { kind: "no_team" }
  /** The Team has no Admin or Lead to make the demo decisions. */
  | { kind: "no_lead" };

const REPO: Asset = { kind: "repo", ref: "https://github.com/acme/shop-web" };
const DEVICE: Asset = { kind: "device", ref: "ada-laptop" };
const PRODUCT: Asset = { kind: "product", ref: "shop" };
const SESSION: Asset = { kind: "agent_session", ref: "session-demo-7f3a" };

const SECRET = "guard/committed-secret";
const ENV = "guard/agent-can-read-env";
const PUSH = "guard/agent-can-push-main";
const DISK = "guard/disk-not-encrypted";
const PRINTED = "guard/agent-printed-secret";
const VULN = "patch/known-vulnerability";

const GUARD_RULES: RuleId[] = [SECRET, ENV, PUSH, DISK];

const secret: Observation = {
  asset: REPO,
  rule_id: SECRET,
  location: { kind: "file", path: "config/payments.ts", line: 12 },
  severity: "critical",
  title: "A live Stripe secret key is committed",
  evidence: {
    summary: "A Stripe live secret key sits in config/payments.ts, line 12",
    secret: { type: "stripe_live_key", path: "config/payments.ts", line: 12, mask: "********a1b2" },
  },
};

const readsEnv = (path: string): Observation => ({
  asset: REPO,
  rule_id: ENV,
  location: { kind: "file", path },
  severity: "high",
  title: "The agent can read .env files",
  evidence: { summary: `permissions.allow in ${path} lets the agent read .env` },
});

const push: Observation = {
  asset: REPO,
  rule_id: PUSH,
  location: { kind: "file", path: ".claude/settings.json" },
  severity: "low",
  title: "The agent may push to main",
  evidence: { summary: "permissions.allow lets the agent run git push origin main" },
};

const disk: Observation = {
  asset: DEVICE,
  rule_id: DISK,
  location: { kind: "setting", name: "disk_encryption" },
  severity: "medium",
  title: "The disk isn't encrypted",
  evidence: { summary: "FileVault is off on ada-laptop" },
};

const vulnerable = (
  pkg: string,
  version: string,
  cve: string,
  severity: Observation["severity"],
): Observation => ({
  asset: PRODUCT,
  rule_id: VULN,
  location: { kind: "dependency", package: pkg, version, vulnerability: cve },
  severity,
  title: `${pkg} ${version} has a known vulnerability`,
  evidence: { summary: `${pkg} ${version} is affected by ${cve}` },
});

const lodash = vulnerable("lodash", "4.17.20", "CVE-2021-23337", "critical");
const minimist = vulnerable("minimist", "1.2.5", "CVE-2021-44906", "high");
const axios = vulnerable("axios", "0.21.1", "CVE-2021-3749", "medium");
const semver = vulnerable("semver", "7.5.1", "CVE-2022-25883", "low");
const ws = vulnerable("ws", "7.4.5", "CVE-2021-32640", "high");

const hours = (now: Date, h: number) => new Date(now.getTime() + h * 3600_000).toISOString();

/**
 * Seeds `team` with the demo Findings, as of `now`: 11 Findings, 7 of them Open (2 Critical), 2 Fixed (one an
 * Unconfirmed fix), 1 Accepted for 90 days and 1 False positive, from Guard and Patch, on a Repo, a Device, a Product
 * and an Agent session. Leaves a Team that already has Findings as it is.
 */
export async function seedDemoFindings({
  withTeam,
  findings,
  team,
  now = new Date(),
}: {
  withTeam: WithTeam;
  findings: Findings;
  team: string;
  now?: Date;
}): Promise<SeedResult> {
  const found = await withTeam(team, async (tx) => ({
    team: await tx.selectFrom("teams").select("id").executeTakeFirst(),
    lead: await tx
      .selectFrom("team_members")
      .select("user_id")
      .where("role", "in", ["lead", "admin"])
      .orderBy("joined_at")
      .orderBy("user_id")
      .executeTakeFirst(),
    findings: await tx
      .selectFrom("findings")
      .select(sql<string>`count(*)`.as("count"))
      .executeTakeFirstOrThrow(),
  }));
  if (found.team === undefined) return { kind: "no_team" };
  if (found.lead === undefined) return { kind: "no_lead" };
  const existing = Number(found.findings.count);
  if (existing > 0) return { kind: "has_findings", findings: existing };

  const guardScan = (n: number, at: number, observations: Observation[]) =>
    findings.reconcile({
      id: `demo-guard-${n}`,
      team,
      module: "guard",
      started_at: hours(now, at),
      assets: [REPO, DEVICE],
      rules: GUARD_RULES,
      observations,
    });
  const patchScan = (n: number, at: number, observations: Observation[]) =>
    findings.reconcile({
      id: `demo-patch-${n}`,
      team,
      module: "patch",
      started_at: hours(now, at),
      assets: [PRODUCT],
      rules: [VULN],
      observations,
    });

  // The second Guard Scan sees the .env rule in another file: the first Finding is Fixed as an Unconfirmed fix. The
  // second Patch Scan no longer sees ws: Fixed.
  await guardScan(1, -48, [secret, readsEnv(".claude/settings.json"), push, disk]);
  await guardScan(2, -24, [secret, readsEnv(".claude/settings.local.json"), push, disk]);
  await patchScan(1, -30, [lodash, minimist, axios, semver, ws]);
  await patchScan(2, -6, [lodash, minimist, axios, semver]);

  const events: MaskedAgentEvent[] = [
    { seq: 3, at: hours(now, -2), name: "PreToolUse", tool: "Bash", text: "cat .env" },
    { seq: 4, at: hours(now, -2), name: "PostToolUse", tool: "Bash", text: "STRIPE_KEY=****a1b2" },
  ];
  await findings.report({
    id: "demo-judge-1",
    team,
    module: "guard",
    started_at: hours(now, -2),
    observations: [
      {
        asset: SESSION,
        rule_id: PRINTED,
        location: { kind: "session" },
        severity: "high",
        title: "The agent printed a secret to the terminal",
        evidence: {
          summary: "The agent ran cat .env and its output held the Stripe key",
          session: { events, events_read: 12, events_hash: await agentEventsHash(events) },
        },
      },
    ],
  });

  const list = await findings.list(team);
  const idOf = (rule: string, where: (f: (typeof list)[number]) => boolean) => {
    const finding = list.find((f) => f.rule_id === rule && where(f));
    if (finding === undefined) throw new Error(`the demo seed lost its ${rule} Finding`);
    return finding.id;
  };
  const actor = { kind: "person", id: found.lead.user_id } as const;
  await findings.accept(
    team,
    idOf(VULN, (f) => f.location.kind === "dependency" && f.location.package === "axios"),
    {
      actor,
      reason: "Demo seed: axios is only called with our own URLs; upgrading next sprint",
      until: hours(now, 90 * 24),
    },
  );
  await findings.markFalsePositive(
    team,
    idOf(PUSH, () => true),
    { actor, reason: "Demo seed: branch protection refuses the push anyway" },
  );
  return { kind: "seeded", findings: list.length };
}

async function main(argv: string[], logger: Logger): Promise<number> {
  const team = argv[0]?.trim();
  if (!team) {
    logger.error(
      "Name the Team to seed: pnpm --filter @warden/server seed <team-id> (its Clerk Organization id, org_…)",
    );
    return 1;
  }
  const pool = createPool(logger, {
    max: 2,
    onConnect: guardDatabaseRole(({ role, reason }) => {
      logger.error(`demo seed: its database role can bypass row-level security. ${reason}.`, {
        role,
        reason,
      });
    }),
  });
  try {
    const withTeam = createWithTeam(pool);
    const findings = createFindings({
      withTeam,
      moveRules: { guard: guardMoveRule, patch: patchMoveRule },
    });
    const result = await seedDemoFindings({ withTeam, findings, team });
    switch (result.kind) {
      case "seeded":
        logger.info("demo Findings seeded", { team, findings: result.findings });
        return 0;
      case "has_findings":
        logger.info("the Team already has Findings; nothing seeded", {
          team,
          findings: result.findings,
        });
        return 0;
      case "no_team":
        logger.error(
          "Warden has no such Team. Open Warden as the Team's Admin first, then seed it",
          { team },
        );
        return 1;
      case "no_lead":
        logger.error("The Team has no Admin or Lead to make the demo decisions", { team });
        return 1;
    }
  } catch (error) {
    logger.error("demo seed failed", { error });
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), createLogger());
}
