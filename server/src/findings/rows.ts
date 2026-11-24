// A Finding as a `findings` row and back. The filtered fields are columns; the nested ones are jsonb.
import { Finding, type Asset } from "@warden/contracts";
import type { Insertable, Selectable } from "kysely";
import type { Database } from "../schema.ts";

export type FindingRow = Selectable<Database["findings"]>;
export type NewFindingRow = Insertable<Database["findings"]>;

/** A date-time as Finding v1 writes it: ISO 8601 in UTC, without milliseconds when there are none. */
export function isoDateTime(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, "Z");
}

/** The row for a Finding, checked against Finding v1 first, so nothing malformed is stored. */
export function toRow(finding: Finding): NewFindingRow {
  const checked = Finding.parse(finding);
  return {
    team_id: checked.team,
    id: checked.id,
    asset_kind: checked.asset.kind,
    asset_ref: checked.asset.ref,
    module: checked.module,
    rule_id: checked.rule_id,
    fingerprint: checked.fingerprint,
    location: JSON.stringify(checked.location),
    severity: checked.severity,
    title: checked.title,
    evidence: JSON.stringify(checked.evidence),
    control: checked.control ? JSON.stringify(checked.control) : null,
    status: checked.status,
    unconfirmed_fix: checked.unconfirmed_fix ? JSON.stringify(checked.unconfirmed_fix) : null,
    accepted_reason: checked.accepted_reason,
    accepted_until: checked.accepted_until,
    first_seen_scan: checked.first_seen_scan,
    last_seen_scan: checked.last_seen_scan,
    moved_to: checked.moved_to,
  };
}

/** The Finding a row holds, parsed with Finding v1: read-only, and checked. */
export function fromRow(row: FindingRow): Finding {
  return Finding.parse({
    id: row.id,
    team: row.team_id,
    asset: { kind: row.asset_kind, ref: row.asset_ref },
    module: row.module,
    rule_id: row.rule_id,
    fingerprint: row.fingerprint,
    location: row.location,
    severity: row.severity,
    title: row.title,
    evidence: row.evidence,
    ...(row.control ? { control: row.control } : {}),
    status: row.status,
    unconfirmed_fix: row.unconfirmed_fix,
    accepted_reason: row.accepted_reason,
    accepted_until: row.accepted_until ? isoDateTime(row.accepted_until) : null,
    first_seen_scan: row.first_seen_scan,
    last_seen_scan: row.last_seen_scan,
    moved_to: row.moved_to,
  });
}

export const sameAsset = (a: Asset, b: Asset) => a.kind === b.kind && a.ref === b.ref;
