// The one reconcile step (ADR 0005): a Scan's or Spot run's Observations, applied to the Team's Findings inside one
// `withTeam` transaction. Only this file decides a Finding's Status; a module never writes one.
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  type Asset,
  type Finding,
  type Module,
  type Observation,
  type RuleId,
} from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import { assetKey, fromRow, toRow } from "./rows.ts";

/** A module's "may have moved" rule: may `opened`, new in the same Scan, be `fixed` moved? */
export type MoveRule = (fixed: Finding, opened: Finding) => boolean;

/** What one reconcile or report did. */
export interface ReconcileOutcome {
  /** The Findings it opened, each with the index of the Observation that opened it. */
  opened: { id: string; observation: number }[];
  /** The Findings it saw again, reopened ones included. */
  seen: string[];
  /** The Findings it marked Fixed. */
  fixed: string[];
  /** The Fixed Findings it saw again, now Open. */
  reopened: string[];
  /** True when this Scan or Spot run was applied before: then nothing changed. */
  alreadyApplied: boolean;
}

/** A Scan (with what it covered) or a Spot run (covering nothing), already parsed by the contracts. */
export interface Run {
  kind: "scan" | "spot_run";
  id: string;
  team: string;
  module: Module;
  started_at: string;
  /** What a Scan covered; a Spot run has none, so it never marks a Finding Fixed. */
  covered?: { assets: readonly Asset[]; rules: readonly RuleId[] };
  observations: readonly Observation[];
}

const runName = (run: Run) => `${run.kind === "scan" ? "Scan" : "Spot run"} ${run.id}`;

/** One Asset and Rule pair, as one string. */
const pairKey = (asset: Asset, rule: string) => JSON.stringify([asset.kind, asset.ref, rule]);

/** One problem on one Asset, as one string. */
const problemKey = (asset: Asset, fingerprintValue: string) =>
  JSON.stringify([asset.kind, asset.ref, fingerprintValue]);

interface Change {
  before: Finding | null;
  after: Finding;
  reason: string;
}

export async function applyRun(
  tx: Transaction<Database>,
  run: Run,
  moveRule: MoveRule | undefined,
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = {
    opened: [],
    seen: [],
    fixed: [],
    reopened: [],
    alreadyApplied: false,
  };

  // One reconcile per Team at a time, so two at once give what the same two give one after the other.
  await sql`select pg_advisory_xact_lock(hashtextextended(${run.team}::text, 0))`.execute(tx);

  const applied = await tx
    .selectFrom("scans")
    .select("id")
    .where("id", "=", run.id)
    .executeTakeFirst();
  if (applied) return { ...outcome, alreadyApplied: true };

  // The foreign key on team_id refuses a Team with no `teams` row here, before anything else is written.
  await tx
    .insertInto("scans")
    .values({
      team_id: run.team,
      id: run.id,
      kind: run.kind,
      module: run.module,
      started_at: run.started_at,
    })
    .execute();

  const coveredPairs = run.covered
    ? run.covered.assets.flatMap((asset) => run.covered!.rules.map((rule) => ({ asset, rule })))
    : [];
  if (coveredPairs.length > 0) {
    await tx
      .insertInto("scan_coverage")
      .values(
        coveredPairs.map(({ asset, rule }) => ({
          team_id: run.team,
          scan_id: run.id,
          asset_kind: asset.kind,
          asset_ref: asset.ref,
          rule_id: rule,
        })),
      )
      .execute();
  }

  // Scan order per Asset and Rule: a pair a later-started Scan already covered is dropped from this run.
  const assets = uniqueAssets([
    ...(run.covered?.assets ?? []),
    ...run.observations.map((o) => o.asset),
  ]);
  const dropped = await newerCoveredPairs(tx, run, assets);
  const counts = (asset: Asset, rule: string) => !dropped.has(pairKey(asset, rule));

  const existing = await loadFindings(tx, run.module, assets);
  const byProblem = new Map(existing.map((f) => [problemKey(f.asset, f.fingerprint), f]));
  const changes: Change[] = [];
  const updates: Finding[] = [];
  const opened: Finding[] = [];
  const seenIds = new Set<string>();

  run.observations.forEach((observation, index) => {
    if (!counts(observation.asset, observation.rule_id)) return;
    const fp = fingerprint(observation.rule_id, observation.location);
    const found = byProblem.get(problemKey(observation.asset, fp));
    if (!found) {
      const finding: Finding = {
        id: randomUUID(),
        team: run.team,
        asset: observation.asset,
        module: run.module,
        rule_id: observation.rule_id,
        fingerprint: fp,
        location: observation.location,
        severity: observation.severity,
        title: observation.title,
        evidence: observation.evidence,
        status: "open",
        unconfirmed_fix: null,
        accepted_reason: null,
        accepted_until: null,
        first_seen_scan: run.id,
        last_seen_scan: run.id,
        moved_to: null,
      };
      opened.push(finding);
      outcome.opened.push({ id: finding.id, observation: index });
      changes.push({ before: null, after: finding, reason: `opened by ${runName(run)}` });
      return;
    }
    seenIds.add(found.id);
    const reopens = found.status === "fixed";
    const after: Finding = {
      ...found,
      location: observation.location,
      title: observation.title,
      evidence: observation.evidence,
      severity: observation.severity,
      last_seen_scan: run.id,
      ...(reopens ? { status: "open", unconfirmed_fix: null } : {}),
    };
    updates.push(after);
    outcome.seen.push(found.id);
    if (reopens) {
      outcome.reopened.push(found.id);
      changes.push({ before: found, after, reason: `seen again by ${runName(run)}` });
    } else if (after.severity !== found.severity) {
      changes.push({
        before: found,
        after,
        reason: `Severity ${found.severity} to ${after.severity}, as seen by ${runName(run)}`,
      });
    }
  });

  if (run.covered) {
    const covered = new Set(coveredPairs.map(({ asset, rule }) => pairKey(asset, rule)));
    for (const finding of existing) {
      if (seenIds.has(finding.id)) continue;
      if (finding.status !== "open" && finding.status !== "accepted") continue;
      const pair = pairKey(finding.asset, finding.rule_id);
      if (!covered.has(pair) || dropped.has(pair)) continue;
      const fixed: Finding = {
        ...finding,
        status: "fixed",
        accepted_reason: null,
        accepted_until: null,
        unconfirmed_fix: null,
      };
      const candidates = moveRule ? opened.filter((o) => moveRule(fixed, o)).map((o) => o.id) : [];
      const after: Finding =
        candidates.length > 0 ? { ...fixed, unconfirmed_fix: { candidates } } : fixed;
      updates.push(after);
      outcome.fixed.push(finding.id);
      changes.push({ before: finding, after, reason: `not seen by ${runName(run)}` });
    }
  }

  if (opened.length > 0) {
    await tx.insertInto("findings").values(opened.map(toRow)).execute();
  }
  for (const finding of updates) {
    const { team_id, id, ...fields } = toRow(finding);
    await tx
      .updateTable("findings")
      .set(fields)
      .where("team_id", "=", team_id)
      .where("id", "=", id)
      .execute();
  }
  if (changes.length > 0) {
    await tx
      .insertInto("finding_history")
      .values(
        changes.map(({ before, after, reason }) => ({
          team_id: run.team,
          finding_id: after.id,
          status_before: before?.status ?? null,
          status_after: after.status,
          severity_before: before?.severity ?? null,
          severity_after: after.severity,
          actor_kind: run.kind,
          actor_id: run.id,
          reason,
        })),
      )
      .execute();
  }
  return outcome;
}

function uniqueAssets(assets: readonly Asset[]): Asset[] {
  return [...new Map(assets.map((asset) => [assetKey(asset), asset])).values()];
}

/** The Asset and Rule pairs on these Assets that a Scan started after this run already covered. */
async function newerCoveredPairs(
  tx: Transaction<Database>,
  run: Run,
  assets: readonly Asset[],
): Promise<Set<string>> {
  if (assets.length === 0) return new Set();
  const rows = await tx
    .selectFrom("scan_coverage as c")
    .innerJoin("scans as s", (join) =>
      join.onRef("s.team_id", "=", "c.team_id").onRef("s.id", "=", "c.scan_id"),
    )
    .select(["c.asset_kind", "c.asset_ref", "c.rule_id"])
    .where("s.started_at", ">", new Date(run.started_at))
    .where("s.id", "<>", run.id)
    .where(
      "c.asset_ref",
      "in",
      assets.map((asset) => asset.ref),
    )
    .execute();
  return new Set(
    rows.map((row) => pairKey({ kind: row.asset_kind, ref: row.asset_ref } as Asset, row.rule_id)),
  );
}

/** The module's Findings on these Assets that aren't merged into another: the ones an Observation can match. */
async function loadFindings(
  tx: Transaction<Database>,
  module: Module,
  assets: readonly Asset[],
): Promise<Finding[]> {
  if (assets.length === 0) return [];
  const keys = new Set(assets.map(assetKey));
  const rows = await tx
    .selectFrom("findings")
    .selectAll()
    .where("module", "=", module)
    .where("moved_to", "is", null)
    .where(
      "asset_ref",
      "in",
      assets.map((asset) => asset.ref),
    )
    .orderBy("id")
    .execute();
  return rows.map(fromRow).filter((finding) => keys.has(assetKey(finding.asset)));
}
