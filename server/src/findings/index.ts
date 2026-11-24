// The Findings module (ADR 0005): the shared code every module reports to, and the only code that writes Findings,
// their Status and their history. Guard, Patch and Vouch import it; it never imports them: each module's move rule
// comes in through `createFindings`, wired by the start-up file.
import { randomUUID } from "node:crypto";
import {
  Actor,
  assetKey,
  Observation,
  problemKey,
  ProposeBody,
  ReasonBody,
  Scan,
  SpotRun,
  type Asset,
  type Finding,
  type HistoryCauseKind,
  type Module,
  type PendingProposal,
  type Proposal,
  type RuleId,
  type Severity,
  type Status,
} from "@warden/contracts";
import type { WithTeam } from "../with-team.ts";
import {
  applyDecision,
  DECISION_INPUT,
  FindingNotFound,
  personOf,
  type Decision,
  type DecisionCall,
  type DecisionInput,
} from "./decisions.ts";
import { applyExpiry, type ExpiryLimits } from "./expiry.ts";
import { readOverview, type FindingsOverview } from "./overview.ts";
import { applyApprove, applyPropose, applyReject, listPending } from "./proposals.ts";
import { applyRun, type MoveRule, type ReconcileOutcome } from "./reconcile.ts";
import { fromRow, isoDateTime, loadFinding } from "./rows.ts";

export {
  DecisionRefused,
  FindingNotFound,
  NotALead,
  type DecisionCall,
  type DecisionInput,
} from "./decisions.ts";
export { DAILY_EXPIRY, type ExpiryLimits } from "./expiry.ts";
export { OVERVIEW_PERIOD_DAYS, type FindingsOverview } from "./overview.ts";
export { ProposalDecided, ProposalNotFound } from "./proposals.ts";
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
  /** What caused it: the Scan or Spot run, the person whose named decision it was, or the Job. Never an agent. */
  cause: { kind: HistoryCauseKind; id: string };
  reason: string;
  /** The Proposal the person's decision approved, and who asked for it; null for any other change. */
  proposal: { id: string; requested_by: Actor } | null;
}

/** What `propose` takes: who asks (a person or an agent), and the decision they suggest. */
export type ProposeInput = ProposeBody & { requester: Actor };

/**
 * One named decision: who decided (a person), and the call's input, checked against its contracts schema (a reason
 * of 1 to 2,000 characters, not only whitespace, and an `until` or a `candidate` where the call takes one).
 */
export type DecisionMethod<C extends DecisionCall> = (
  team: string,
  id: string,
  input: DecisionInput<C> & { actor: Actor },
) => Promise<Finding>;

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
  /**
   * The Overview's numbers (story 10): the Team's latest Scan, whether it has any Finding, its Open Findings at the
   * start of the last `days` days and now, and the Fix rate over them, read from the Findings and their history.
   */
  overview(team: string, days: number): Promise<FindingsOverview>;

  // A person's named decisions. Each throws for an agent Actor before anything is read, a zod error for bad input,
  // NotALead when, under the Team's lock, the person isn't a Lead (any more), FindingNotFound for an id the Team
  // doesn't have, and DecisionRefused for a Status the call doesn't take; after any of them nothing is written. Each
  // returns the Finding as changed, parsed with Finding v1.

  /** Open or Accepted (renewing) to Accepted, until `until`, which must be later than now. */
  accept: DecisionMethod<"accept">;
  /** Open or Accepted to False positive. */
  markFalsePositive: DecisionMethod<"markFalsePositive">;
  /** Clears a Fixed Finding's Unconfirmed fix; it stays Fixed and its candidates stay as they are. */
  confirmFix: DecisionMethod<"confirmFix">;
  /**
   * Merges `candidate`, an Open Finding its Unconfirmed fix lists, with the same module, Rule and Asset, into this
   * Fixed one: the candidate is Fixed with `moved_to` this id, and this one reopens with its id and first Scan, at the
   * candidate's location. Any other Unconfirmed fix stops listing the candidate. Returns this one.
   */
  markMoved: DecisionMethod<"markMoved">;
  /** False positive or Accepted to Open. */
  reopen: DecisionMethod<"reopen">;

  // Proposals (ADR 0005, ADR 0008): an agent or a person suggests accept or mark_false_positive; a Lead decides.

  /**
   * Stores a pending Proposal and changes no Finding. Throws a zod error for bad input (an `until` exactly on an
   * accept, later than now), and FindingNotFound or DecisionRefused when the decision would be refused on the Finding
   * now; nothing is written then. No Lead check: anyone in the Team, or an agent, may propose.
   */
  propose(team: string, findingId: string, input: ProposeInput): Promise<Proposal>;
  /**
   * Makes the Proposal's decision as `actor`, a person, through the named call's own checks (the Lead recheck, the
   * Status rules, an accept's until still later than now), and marks it approved, in one transaction. Throws for an
   * agent before anything is read; ProposalNotFound, ProposalDecided, NotALead, DecisionRefused; nothing is written
   * after any of them.
   */
  approveProposal(team: string, proposalId: string, input: { actor: Actor }): Promise<Proposal>;
  /** Marks the Proposal rejected by `actor`, a Lead, with their reason. The Finding doesn't change; no history row. */
  rejectProposal(
    team: string,
    proposalId: string,
    input: ReasonBody & { actor: Actor },
  ): Promise<Proposal>;
  /**
   * The Team's pending Proposals, oldest first, each `stale` when its Finding has changed since it was asked: the
   * same test approveProposal refuses one with. Approved and rejected ones aren't listed.
   */
  pendingProposals(team: string): Promise<PendingProposal[]>;

  /**
   * The daily Job's work for one Team: every Accepted Finding whose until is at or before `now` reopens, with a `job`
   * history row. Returns the reopened ids; run again with the same `now`, it changes nothing. It fails, writing
   * nothing, after waiting 30 s for the Team's lock or 60 s on one statement (`limits` changes either, for tests).
   */
  expireAcceptances(team: string, now: Date, limits?: ExpiryLimits): Promise<string[]>;
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

  /**
   * The named call `call`: the person first (an agent throws before anything is read), then the input against the
   * call's schema in DECISION_INPUT, then the decision itself.
   */
  const decision =
    <C extends DecisionCall>(call: C): DecisionMethod<C> =>
    async (team, id, { actor, ...input }) => {
      const person = personOf(actor);
      const checked = { call, ...DECISION_INPUT[call].parse(input) } as Decision;
      return withTeam(team, (tx) => applyDecision(tx, team, id, person, checked));
    };

  return {
    reconcile,

    accept: decision("accept"),
    markFalsePositive: decision("markFalsePositive"),
    confirmFix: decision("confirmFix"),
    markMoved: decision("markMoved"),
    reopen: decision("reopen"),

    async propose(team, findingId, { requester, ...body }) {
      const who = Actor.parse(requester);
      const checked = ProposeBody.parse(body);
      return withTeam(team, (tx) => applyPropose(tx, team, findingId, who, checked));
    },

    async approveProposal(team, proposalId, { actor }) {
      const person = personOf(actor);
      return withTeam(team, (tx) => applyApprove(tx, team, proposalId, person));
    },

    async rejectProposal(team, proposalId, { actor, ...input }) {
      const person = personOf(actor);
      const checked = ReasonBody.parse(input);
      return withTeam(team, (tx) => applyReject(tx, team, proposalId, person, checked.reason));
    },

    pendingProposals(team) {
      return withTeam(team, (tx) => listPending(tx, team));
    },

    expireAcceptances(team, now, limits) {
      return withTeam(team, (tx) => applyExpiry(tx, team, now, limits));
    },

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

    overview(team, days) {
      return withTeam(team, (tx) => readOverview(tx, team, days));
    },

    history(team, findingId) {
      return withTeam(team, async (tx) => {
        if (!(await loadFinding(tx, team, findingId))) throw new FindingNotFound(findingId);
        const rows = await tx
          .selectFrom("finding_history as h")
          .leftJoin("proposals as p", (join) =>
            join.onRef("p.team_id", "=", "h.team_id").onRef("p.id", "=", "h.proposal_id"),
          )
          .selectAll("h")
          .select(["p.requested_by_kind", "p.requested_by_id"])
          .where("h.finding_id", "=", findingId)
          .orderBy("h.id")
          .execute();
        return rows.map((row) => ({
          at: isoDateTime(row.at),
          status_before: row.status_before,
          status_after: row.status_after,
          severity_before: row.severity_before,
          severity_after: row.severity_after,
          cause: { kind: row.actor_kind, id: row.actor_id },
          reason: row.reason,
          proposal:
            row.proposal_id === null
              ? null
              : {
                  id: row.proposal_id,
                  requested_by: { kind: row.requested_by_kind!, id: row.requested_by_id! },
                },
        }));
      });
    },
  };
}
