// The Kysely table types for what the migrations in server/migrations make. Every table here is Team-owned and kept
// apart by row-level security (ADR 0006); `findUnprotectedTables` checks that on the real schema. The enum columns
// carry the contracts' types, which the migrations' check constraints match.
import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type {
  Actor,
  AssetKind,
  Control,
  Evidence,
  HistoryCauseKind,
  Location,
  Module,
  ProposalDecision,
  ProposalState,
  Role,
  Severity,
  Status,
} from "@warden/contracts";

/** A jsonb column written as a JSON string and read back parsed. */
type Json<T extends object> = JSONColumnType<T, string, string>;

/** What kind of run a Scan row records: a Scan or a Spot run. */
export type RunKind = Exclude<HistoryCauseKind, "person" | "job">;

/** Who caused a Finding's history row: the contracts' list, which 0006_proposals's check matches. */
export type HistoryActorKind = HistoryCauseKind;

/** How a Role history row came about: the Team's first visit, an invited person's first visit, or a Role change. */
export type RoleChange = "created_team" | "joined" | "changed";

export interface Database {
  /** One row per Team, keyed by its Clerk Organization id; every later Team-owned table points at it. */
  teams: {
    id: string;
    created_at: Generated<Date>;
  };

  /** Each person's Role in the Team, by Clerk user id (0004_team_members). Written only by the members module. */
  team_members: {
    team_id: string;
    user_id: string;
    role: Role;
    joined_at: Generated<Date>;
  };

  /** Append-only: one row per Role change. A trigger refuses update, delete, truncate. */
  role_history: {
    team_id: string;
    id: Generated<string>;
    user_id: string;
    role_before: Role | null;
    role_after: Role;
    change: RoleChange;
    actor_id: string;
    at: Generated<Date>;
  };

  /** One row per Finding, every Finding v1 field (0003_findings). Written only by the Findings module. */
  findings: {
    team_id: string;
    id: string;
    asset_kind: AssetKind;
    asset_ref: string;
    module: Module;
    rule_id: string;
    fingerprint: string;
    location: Json<Location>;
    severity: Severity;
    title: string;
    evidence: Json<Evidence>;
    control: JSONColumnType<Control | null, string | null, string | null>;
    status: Status;
    unconfirmed_fix: JSONColumnType<{ candidates: string[] } | null, string | null, string | null>;
    accepted_reason: string | null;
    accepted_until: ColumnType<Date | null, string | null, string | null>;
    first_seen_scan: string;
    last_seen_scan: string;
    moved_to: string | null;
  };

  /** Every Scan and Spot run reconciled, by id, so a retried one changes nothing. */
  scans: {
    team_id: string;
    id: string;
    kind: RunKind;
    module: Module;
    started_at: ColumnType<Date, string, string>;
    applied_at: Generated<Date>;
  };

  /** The Asset and Rule pairs each Scan covered; a Spot run has none. */
  scan_coverage: {
    team_id: string;
    scan_id: string;
    asset_kind: AssetKind;
    asset_ref: string;
    rule_id: string;
  };

  /** Append-only: one row per opening, Status change or Severity change. A trigger refuses update, delete, truncate. */
  finding_history: {
    team_id: string;
    id: Generated<string>;
    finding_id: string;
    at: Generated<Date>;
    status_before: Status | null;
    status_after: Status;
    severity_before: Severity | null;
    severity_after: Severity;
    actor_kind: HistoryActorKind;
    actor_id: string;
    reason: string;
    /** The Proposal a person's decision approved; null on every other row (0006_proposals). */
    proposal_id: ColumnType<string | null, string | null | undefined, never>;
  };

  /**
   * A decision an agent or a Member suggests (0006_proposals). Decided once, by a Lead, then kept: a trigger refuses
   * any other update, and every delete and truncate.
   */
  proposals: {
    team_id: string;
    id: string;
    finding_id: string;
    decision: ProposalDecision;
    reason: string;
    /** Set exactly on an accept. */
    accepted_until: ColumnType<Date | null, string | null, never>;
    requested_by_kind: Actor["kind"];
    requested_by_id: string;
    requested_at: Generated<Date>;
    state: Generated<ProposalState>;
    decided_by: string | null;
    decided_at: ColumnType<Date | null, never, Date>;
    decided_reason: string | null;
  };
}
