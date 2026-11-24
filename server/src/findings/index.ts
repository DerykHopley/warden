// The Findings module (ADR 0005): the shared code every module reports to, and the only code that writes Findings,
// their Status and their history. Guard, Patch and Vouch import it; it never imports them: each module's move rule
// comes in through `createFindings`, wired by the start-up file.
import { randomUUID } from "node:crypto";
import {
  AcceptBody,
  assetKey,
  MarkMovedBody,
  Observation,
  problemKey,
  ReasonBody,
  Scan,
  SpotRun,
  type Actor,
  type Asset,
  type Finding,
  type Module,
  type RuleId,
  type Severity,
  type Status,
} from "@warden/contracts";
import type { HistoryActorKind } from "../schema.ts";
import type { WithTeam } from "../with-team.ts";
import { applyDecision, FindingNotFound, personOf, type Decision } from "./decisions.ts";
import { applyRun, type MoveRule, type ReconcileOutcome } from "./reconcile.ts";
import { fromRow, isoDateTime } from "./rows.ts";

export { DecisionRefused, FindingNotFound, type DecisionCall } from "./decisions.ts";
export type { MoveRule, ReconcileOutcome } from "./reconcile.ts";
export { sameAsset } from "./rows.ts";

/** One change in a Finding's history, oldest first. Never edited. */
export interface HistoryEntry {
  at: string;
  /** Null when this entry opened the Finding. */
  status_before: Status | null;
  status_after: Status;
  severity_before: Severity | null;
  severity_after: Severity;
  /** What caused it: the Scan or Spot run, or the person whose named decision it was. Never an agent. */
  cause: { kind: HistoryActorKind; id: string };
  reason: string;
}

/** What every named decision takes: who decided, a person, and why (1 to 2,000 characters, not only whitespace). */
export interface DecisionInput {
  actor: Actor;
  reason: string;
}

/** What a module's scan callback gets: `saw` reports one Observation. */
export interface ScanRecorder {
  /** Parses the Observation, and throws at once for one outside the Scan's Assets and Rules, or one seen twice. */
  saw(observation: Observation): void;
}

export interface ScanCoverage {
  team: string;
  module: Module;
  /** The Assets the Scan covers. */
  assets: Asset[];
  /** The Rules the Scan covers. */
  rules: RuleId[];
}

export interface Findings {
  /** Applies one Scan. A Scan the contracts refuse throws before anything is written; a retried one changes nothing. */
  reconcile(scan: Scan): Promise<ReconcileOutcome>;
  /** Applies one Spot run: opens and updates Findings, reopens a Fixed one it sees, and never marks one Fixed. */
  report(spotRun: SpotRun): Promise<ReconcileOutcome>;
  /** The call a module writes: collects what the callback `saw`, then reconciles it as one new Scan. */
  scan(
    coverage: ScanCoverage,
    work: (scan: ScanRecorder) => Promise<void>,
  ): Promise<ReconcileOutcome>;
  /** The Team's Findings, each parsed with Finding v1, so they come back read-only. */
  list(team: string): Promise<Finding[]>;
  /** One Finding's history, oldest first. Throws FindingNotFound for an id the Team doesn't have. */
  history(team: string, findingId: string): Promise<HistoryEntry[]>;

  // A person's named decisions. Each throws for an agent Actor before anything is read, a zod error for bad input,
  // FindingNotFound for an id the Team doesn't have, and DecisionRefused for a Status the call doesn't take; after
  // any of them nothing is written. Each returns the Finding as changed, parsed with Finding v1.

  /** Open or Accepted (renewing) to Accepted, until `until`, which must be later than now. */
  accept(team: string, id: string, input: DecisionInput & { until: string }): Promise<Finding>;
  /** Open or Accepted to False positive. */
  markFalsePositive(team: string, id: string, input: DecisionInput): Promise<Finding>;
  /** Clears a Fixed Finding's Unconfirmed fix; it stays Fixed and its candidates stay as they are. */
  confirmFix(team: string, id: string, input: DecisionInput): Promise<Finding>;
  /**
   * Merges `candidate`, an Open Finding its Unconfirmed fix lists, into this Fixed one: the candidate is Fixed with
   * `moved_to` this id, and this one reopens with its id and first Scan, at the candidate's location. Returns this one.
   */
  markMoved(
    team: string,
    id: string,
    input: DecisionInput & { candidate: string },
  ): Promise<Finding>;
  /** False positive or Accepted to Open. */
  reopen(team: string, id: string, input: DecisionInput): Promise<Finding>;
}

export function createFindings({
  withTeam,
  moveRules,
}: {
  withTeam: WithTeam;
  /** Each module's "may have moved" rule. A module without one never gets an Unconfirmed fix. */
  moveRules: Partial<Record<Module, MoveRule>>;
}): Findings {
  const reconcile = async (value: Scan) => {
    const scan = Scan.parse(value);
    return withTeam(scan.team, (tx) =>
      applyRun(
        tx,
        { ...scan, kind: "scan", covered: { assets: scan.assets, rules: scan.rules } },
        moveRules[scan.module],
      ),
    );
  };

  /** The person first (an agent throws before anything is read), then the input, then the decision itself. */
  const decide = async (team: string, id: string, actor: Actor, decision: () => Decision) => {
    const person = personOf(actor);
    const checked = decision();
    return withTeam(team, (tx) => applyDecision(tx, team, id, person, checked));
  };

  return {
    reconcile,

    accept: (team, id, { actor, ...body }) =>
      decide(team, id, actor, () => ({ call: "accept", ...AcceptBody.parse(body) })),
    markFalsePositive: (team, id, { actor, ...body }) =>
      decide(team, id, actor, () => ({ call: "markFalsePositive", ...ReasonBody.parse(body) })),
    confirmFix: (team, id, { actor, ...body }) =>
      decide(team, id, actor, () => ({ call: "confirmFix", ...ReasonBody.parse(body) })),
    markMoved: (team, id, { actor, ...body }) =>
      decide(team, id, actor, () => ({ call: "markMoved", ...MarkMovedBody.parse(body) })),
    reopen: (team, id, { actor, ...body }) =>
      decide(team, id, actor, () => ({ call: "reopen", ...ReasonBody.parse(body) })),

    async report(value) {
      const run = SpotRun.parse(value);
      return withTeam(run.team, (tx) =>
        applyRun(tx, { ...run, kind: "spot_run" }, moveRules[run.module]),
      );
    },

    async scan({ team, module, assets, rules }, work) {
      const id = randomUUID();
      const started_at = new Date().toISOString();
      const covered = new Set(assets.map(assetKey));
      const coveredRules = new Set<string>(rules);
      const observations: Observation[] = [];
      const reported = new Map<string, number>();
      let open = true;

      const recorder: ScanRecorder = {
        saw(value) {
          if (!open) throw new Error("saw: this Scan has ended");
          const observation = Observation.parse(value);
          const { asset, rule_id } = observation;
          if (!covered.has(assetKey(asset))) {
            throw new Error(`saw: the Asset ${assetKey(asset)} isn't one this Scan covers`);
          }
          if (!coveredRules.has(rule_id)) {
            throw new Error(`saw: the Rule ${rule_id} isn't one this Scan covers`);
          }
          const key = problemKey(observation);
          const earlier = reported.get(key);
          if (earlier !== undefined) {
            throw new Error(
              `saw: the same problem (Asset and Fingerprint) as Observation ${earlier}: report each problem once`,
            );
          }
          reported.set(key, observations.length);
          observations.push(observation);
        },
      };
      try {
        await work(recorder);
      } finally {
        // Returned or thrown, the Scan has ended: a recorder kept past it refuses what it's handed.
        open = false;
      }
      return reconcile({ id, team, module, started_at, assets, rules, observations });
    },

    list(team) {
      return withTeam(team, async (tx) =>
        (await tx.selectFrom("findings").selectAll().orderBy("id").execute()).map(fromRow),
      );
    },

    history(team, findingId) {
      return withTeam(team, async (tx) => {
        const finding = await tx
          .selectFrom("findings")
          .select("id")
          .where("team_id", "=", team)
          .where("id", "=", findingId)
          .executeTakeFirst();
        if (!finding) throw new FindingNotFound(findingId);
        const rows = await tx
          .selectFrom("finding_history")
          .selectAll()
          .where("finding_id", "=", findingId)
          .orderBy("id")
          .execute();
        return rows.map((row) => ({
          at: isoDateTime(row.at),
          status_before: row.status_before,
          status_after: row.status_after,
          severity_before: row.severity_before,
          severity_after: row.severity_after,
          cause: { kind: row.actor_kind, id: row.actor_id },
          reason: row.reason,
        }));
      });
    },
  };
}
