// The Kysely table types for what the migrations in server/migrations make. Every table here is Team-owned and kept
// apart by row-level security (ADR 0006); `findUnprotectedTables` checks that on the real schema.
import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type { Control, Evidence, Location } from "@warden/contracts";

/** A jsonb column written as a JSON string and read back parsed. */
type Json<T extends object> = JSONColumnType<T, string, string>;

export interface Database {
  /** One row per Team, keyed by its Clerk Organization id; every later Team-owned table points at it. */
  teams: {
    id: string;
    created_at: Generated<Date>;
  };

  /** One row per Finding, every Finding v1 field (0003_findings). Written only by the Findings module. */
  findings: {
    team_id: string;
    id: string;
    asset_kind: string;
    asset_ref: string;
    module: string;
    rule_id: string;
    fingerprint: string;
    location: Json<Location>;
    severity: string;
    title: string;
    evidence: Json<Evidence>;
    control: JSONColumnType<Control | null, string | null, string | null>;
    status: string;
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
    kind: "scan" | "spot_run";
    module: string;
    started_at: ColumnType<Date, string, string>;
    applied_at: Generated<Date>;
  };

  /** The Asset and Rule pairs each Scan covered; a Spot run has none. */
  scan_coverage: {
    team_id: string;
    scan_id: string;
    asset_kind: string;
    asset_ref: string;
    rule_id: string;
  };

  /** Append-only: one row per opening, Status change or Severity change. A trigger refuses update, delete, truncate. */
  finding_history: {
    team_id: string;
    id: Generated<string>;
    finding_id: string;
    at: Generated<Date>;
    status_before: string | null;
    status_after: string;
    severity_before: string | null;
    severity_after: string;
    actor_kind: "scan" | "spot_run";
    actor_id: string;
    reason: string;
  };
}
