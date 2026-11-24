// The one reconcile step (ADR 0005): a Scan's or Spot run's Observations, applied to the Team's Findings inside one
// `withTeam` transaction. Only this file decides a Finding's Status; a module never writes one.
import { randomUUID } from "node:crypto";
import {
  assetKey,
  fingerprint,
  problemKeyOf,
  type Asset,
  type Finding,
  type Module,
  type Observation,
  type RuleId,
} from "@warden/contracts";
import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.ts";
import { fromRow, toRow } from "./rows.ts";

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

interface RunFields {
  id: string;
  team: string;
  module: Module;
  started_at: string;
  observations: readonly Observation[];
}

/** A Scan, with what it covered, or a Spot run, which covers nothing and so never marks a Finding Fixed. */
export type Run =
  | (RunFields & { kind: "scan"; covered: { assets: readonly Asset[]; rules: readonly RuleId[] } })
  | (RunFields & { kind: "spot_run" });

/** Rows per insert or update statement: well under Postgres's 65,535 parameters for every table here. */
const CHUNK = 1000;

const runName = (run: Run) => `${run.kind === "scan" ? "Scan" : "Spot run"} ${run.id}`;

/** One Asset and Rule pair, as one string. */
const pairKey = (asset: Asset, rule: string) => JSON.stringify([asset.kind, asset.ref, rule]);

interface Change {
  before: Finding | null;
  after: Finding;
  reason: string;
}

/**
 * One change to a Team's Findings at a time, a reconcile or a person's decision, held until the transaction ends: two
 * at once give what the same two give one after the other.
 */
export async function lockTeamFindings(tx: Transaction<Database>, team: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${team}::text, 0))`.execute(tx);
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

  await lockTeamFindings(tx, run.team);

  const applied = await tx
    .selectFrom("scans")
    .select(["kind", "module", "started_at"])
    .where("id", "=", run.id)
    .executeTakeFirst();
  if (applied) {
    const same =
      applied.kind === run.kind &&
      applied.module === run.module &&
      applied.started_at.getTime() === Date.parse(run.started_at);
    if (!same) {
      throw new Error(
        `the run id "${run.id}" was already applied to a different run (a ${applied.module} ` +
          `${applied.kind} started ${applied.started_at.toISOString()}): a new run needs a new id`,
      );
    }
    return { ...outcome, alreadyApplied: true };
  }

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

  const coveredPairs =
    run.kind === "scan"
      ? run.covered.assets.flatMap((asset) => run.covered.rules.map((rule) => ({ asset, rule })))
      : [];
  for (const pairs of chunks(coveredPairs)) {
    await tx
      .insertInto("scan_coverage")
      .values(
        pairs.map(({ asset, rule }) => ({
          team_id: run.team,
          scan_id: run.id,
          asset_kind: asset.kind,
          asset_ref: asset.ref,
          rule_id: rule,
        })),
      )
      .execute();
  }

  // Scan order per Asset and Rule: a pair a later-started Scan already covered is superseded in this run.
  const assets = uniqueAssets([
    ...(run.kind === "scan" ? run.covered.assets : []),
    ...run.observations.map((o) => o.asset),
  ]);
  const superseded = await newerCoveredPairs(tx, run, assets);
  const notSuperseded = (asset: Asset, rule: string) => !superseded.has(pairKey(asset, rule));

  const existing = await loadFindings(tx, run.module, assets);
  const byProblem = new Map(existing.map((f) => [problemKeyOf(f.asset, f.fingerprint), f]));
  const changes: Change[] = [];
  const updates: Finding[] = [];
  const opened: Finding[] = [];
  const seenIds = new Set<string>();

  run.observations.forEach((observation, index) => {
    if (!notSuperseded(observation.asset, observation.rule_id)) return;
    const fp = fingerprint(observation.rule_id, observation.location);
    const found = byProblem.get(problemKeyOf(observation.asset, fp));
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

  if (run.kind === "scan") {
    const covered = new Set(coveredPairs.map(({ asset, rule }) => pairKey(asset, rule)));
    const unseen = existing.filter(
      (finding) =>
        !seenIds.has(finding.id) &&
        (finding.status === "open" || finding.status === "accepted") &&
        covered.has(pairKey(finding.asset, finding.rule_id)) &&
        notSuperseded(finding.asset, finding.rule_id),
    );
    // A Finding last seen by a run that started after this Scan is newer news than this Scan's not seeing it.
    const seenLater = await runsStartedAfter(
      tx,
      run.started_at,
      unseen.map((f) => f.last_seen_scan),
    );
    for (const finding of unseen) {
      if (seenLater.has(finding.last_seen_scan)) continue;
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

  for (const rows of chunks(opened)) {
    await tx.insertInto("findings").values(rows.map(toRow)).execute();
  }
  for (const rows of chunks(updates)) {
    await updateFindings(tx, run.team, rows);
  }
  for (const rows of chunks(changes)) {
    await tx
      .insertInto("finding_history")
      .values(
        rows.map(({ before, after, reason }) => ({
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

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let start = 0; start < items.length; start += CHUNK) {
    yield items.slice(start, start + CHUNK);
  }
}

function uniqueAssets(assets: readonly Asset[]): Asset[] {
  return [...new Map(assets.map((asset) => [assetKey(asset), asset])).values()];
}

/**
 * Writes the fields reconcile changes (what a sighting brings, the Status and its lifecycle fields) for many Findings
 * in one statement: the rows travel as one jsonb parameter. Each is checked against Finding v1 first.
 */
async function updateFindings(tx: Transaction<Database>, team: string, findings: Finding[]) {
  const rows = findings.map((finding) => {
    const row = toRow(finding);
    return {
      id: row.id,
      location: finding.location,
      severity: row.severity,
      title: row.title,
      evidence: finding.evidence,
      status: row.status,
      unconfirmed_fix: finding.unconfirmed_fix,
      accepted_reason: row.accepted_reason,
      accepted_until: row.accepted_until,
      last_seen_scan: row.last_seen_scan,
    };
  });
  await sql`
    update findings as f
       set location = v.location, severity = v.severity, title = v.title, evidence = v.evidence,
           status = v.status, unconfirmed_fix = v.unconfirmed_fix, accepted_reason = v.accepted_reason,
           accepted_until = v.accepted_until, last_seen_scan = v.last_seen_scan
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v (
             id text, location jsonb, severity text, title text, evidence jsonb, status text,
             unconfirmed_fix jsonb, accepted_reason text, accepted_until timestamptz, last_seen_scan text)
     where f.team_id = ${team} and f.id = v.id
  `.execute(tx);
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
    .where(sql<boolean>`c.asset_ref = any(${assets.map((asset) => asset.ref)}::text[])`)
    .execute();
  return new Set(
    rows.map((row) => pairKey({ kind: row.asset_kind, ref: row.asset_ref }, row.rule_id)),
  );
}

/** Which of these Scan and Spot run ids started after `startedAt`. An id never stored (a case's given) didn't. */
async function runsStartedAfter(
  tx: Transaction<Database>,
  startedAt: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .selectFrom("scans")
    .select("id")
    .where(sql<boolean>`id = any(${[...new Set(ids)]}::text[])`)
    .where("started_at", ">", new Date(startedAt))
    .execute();
  return new Set(rows.map((row) => row.id));
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
    .where(sql<boolean>`asset_ref = any(${assets.map((asset) => asset.ref)}::text[])`)
    .orderBy("id")
    .execute();
  return rows.map(fromRow).filter((finding) => keys.has(assetKey(finding.asset)));
}
