// The Kysely table types for what the migrations in server/migrations make. Every table here but the CVE snapshot's
// (last, and named in `NOT_TEAM_DATA`) is Team-owned and kept apart by row-level security (ADR 0006);
// `findUnprotectedTables` checks that on the real schema. The enum columns
// carry the contracts' types, which the migrations' check constraints match.
import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type {
  Actor,
  Asset,
  AssetKind,
  CatalogueId,
  Control,
  Evidence,
  HistoryCauseKind,
  Location,
  Module,
  ProposalDecision,
  ProposalState,
  ReviewedVerdict,
  ReviewOutcome,
  Role,
  ScanState,
  Severity,
  Status,
  Usage,
  Verdict,
} from "@warden/contracts";

/** A jsonb column written as a JSON string and read back parsed. */
type Json<T extends object> = JSONColumnType<T, string, string>;

/** What kind of run a Scan row records: a Scan or a Spot run. */
export type RunKind = Exclude<HistoryCauseKind, "person" | "job">;

/** Who caused a Finding's history row: the contracts' list, which 0006_proposals's check matches. */
export type HistoryActorKind = HistoryCauseKind;

/** What a write-grant row records: the write app granted on an installation, or the grant gone (slice 2 writes it). */
export type WriteGrantEvent = "granted" | "revoked";

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
    /**
     * The earliest pending Proposal on the same Finding, on a later one stored before a Finding took one pending
     * Proposal at a time (0007_one_pending_proposal). Only that migration sets it; never in an answer.
     */
    duplicate_of: ColumnType<string | null, never, never>;
  };

  /**
   * A queued Scan (0010_scan_requests): what a Lead asked to scan and where its Scan Job is. Written only by the Scans
   * module. Each time is set by the database; a failed Scan stores no message.
   */
  scan_requests: {
    team_id: string;
    id: string;
    module: Module;
    assets: Json<Asset[]>;
    rules: string[];
    state: ColumnType<ScanState, ScanState | undefined, ScanState>;
    requested_by: string;
    queued_at: ColumnType<Date, Date | undefined, never>;
    started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
    ended_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  };

  /**
   * A GitHub installation a Team linked (0011_repo_assets): one Team per installation id. Written only by the Guard
   * module's Repo Assets store. Ids are bigint, which pg reads back as a string.
   */
  github_installations: {
    team_id: string;
    installation_id: ColumnType<string, number, never>;
    linked_by: string;
    linked_at: ColumnType<Date, Date | undefined, Date>;
  };

  /**
   * The Team that holds a write-app installation (0015_github_write_grants): one row per installation, written on its
   * first grant and never changed, so an installation's grants belong to one Team. Ids are bigint, read back as strings.
   */
  github_write_installations: {
    installation_id: ColumnType<string, number, never>;
    team_id: ColumnType<string, string, never>;
  };

  /**
   * A Team's write grant, one row per event (0015_github_write_grants): a `granted` or `revoked` of the write app on
   * an installation, who caused it (a Clerk user id) and when. Append-only: rows are only ever inserted. Written only by
   * the Guard module's write-grants store; the newest row per installation says whether the grant holds.
   */
  github_write_grants: {
    team_id: string;
    id: Generated<string>;
    installation_id: ColumnType<string, number, never>;
    event: WriteGrantEvent;
    caused_by: string;
    at: Generated<Date>;
  };

  /**
   * A Fix PR opened for a Finding (0016_fix_prs): its URL, number and branch, who opened it (a Clerk user id) and when.
   * Append-only: rows are only ever inserted, one per PR. Written only by the Guard module's Fix PRs store; the newest
   * row per Finding is the one the store answers.
   */
  fix_prs: {
    team_id: string;
    id: Generated<string>;
    finding_id: string;
    url: string;
    number: number;
    branch: string;
    opened_by: string;
    at: Generated<Date>;
  };

  /**
   * A Catalogue a Team has set on or off (0017_team_catalogues), who set it (an Admin's Clerk user id) and when: one
   * row per Team and Catalogue, replaced on each change. No row: off. Written only by the Vouch module's Team
   * Catalogues store.
   */
  team_catalogues: {
    team_id: string;
    catalogue: CatalogueId;
    turned_on: boolean;
    set_by: string;
    set_at: Generated<Date>;
  };

  /**
   * A review of a judged Control's Verdict (0018_control_reviews): the Verdict the server worked out when it was
   * written, a confirm or an override, the reviewed Verdict, the reason (required on an override), who reviewed (a
   * Clerk user id) and when. Append-only: rows are only ever inserted. Written only by the Vouch module's Control
   * Reviews store; a Control's newest row is its review. Ids are bigint, read back as strings.
   */
  control_reviews: {
    team_id: string;
    id: Generated<string>;
    catalogue: CatalogueId;
    control_ref: string;
    worked_out_verdict: Verdict;
    outcome: ReviewOutcome;
    verdict: ReviewedVerdict;
    reason: string | null;
    reviewed_by: string;
    reviewed_at: Generated<Date>;
  };

  /**
   * A repo an installation lists, as one of the Team's Repo Assets (0011_repo_assets): one row per installation that
   * lists it, keyed by (team_id, installation_id, ref) since 0012_repo_assets_per_installation.
   */
  repo_assets: {
    team_id: string;
    ref: string;
    github_id: ColumnType<string, number, number>;
    installation_id: ColumnType<string, number, number>;
    listed_at: ColumnType<Date, Date | undefined, Date>;
  };

  /** What a Team ships (0008_products): written and read only by the Patch module. A name is unique in a Team, any case. */
  products: {
    team_id: string;
    id: string;
    name: string;
    repo_urls: string[];
    created_at: Generated<Date>;
  };

  /** One row per framework a Product uses (0008_products); deleting the Product deletes them. */
  product_dependencies: {
    team_id: string;
    product_id: string;
    framework: string;
    version: string | null;
    usage: Usage;
    internet_facing: boolean;
  };

  // Patch's CVE snapshot (0009_cve_reference): public reference data, the same for every Team, so not Team-owned and
  // under no row-level security. The app only reads them; the loader (cve-snapshot.ts) writes them as warden_migrate.

  /** The snapshot loaded now: one row. */
  cve_snapshot: {
    only_row: boolean;
    as_of: Date;
    digest: string;
    loaded_at: Date;
  };

  /** Each source's manifest entry: its licence and attribution. */
  cve_sources: {
    id: string;
    name: string;
    licence: string;
    attribution: string;
    notice: string | null;
    url: string;
    retrieved: Date;
    as_of: Date | null;
    count: number;
  };

  /** NVD's CVEs for Patch's frameworks; `product` is a framework id. NVD's severity as given, NONE and null included. */
  cves: {
    id: string;
    product: string;
    product_source: "text" | "cpe";
    published: Date;
    severity: string | null;
    cvss: number | null;
    cwes: string[];
    description: string;
    url: string;
  };

  /** CISA's Known Exploited Vulnerabilities entries for those CVEs. */
  cve_kev: {
    cve_id: string;
    name: string;
    date_added: Date;
    due_date: Date;
    ransomware_use: string;
    required_action: string;
  };

  /** FIRST's EPSS score and percentile for each CVE. */
  cve_epss: {
    cve_id: string;
    score: number;
    percentile: number;
    date: Date;
  };

  /** OSV's entries, one row each; `position` keeps OSV's order, and `ranges` is OSV's list as stored. */
  cve_osv: {
    position: number;
    cve_id: string;
    product: string;
    ecosystem: string;
    package: string;
    advisory: string;
    ranges: { introduced: string | null; fixed: string | null; last_affected: string | null }[];
    fixed: string[];
  };
}
