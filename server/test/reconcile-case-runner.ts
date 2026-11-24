// Runs one reconcile case (contracts/README.md, "The reconcile cases") against the real Findings module: the case's
// Team becomes one of its own, `given` goes straight into `findings`, each step goes through `reconcile`, `report`
// or the named decision call, and the Team's Findings are compared with `expect`, refs resolved.
import { randomUUID } from "node:crypto";
import type {
  ExpectedFinding,
  Finding,
  FindingRef,
  ReconcileCase,
  ReconcileStep,
} from "@warden/contracts";
import type { Findings } from "../src/findings/index.ts";
import { toRow } from "../src/findings/rows.ts";
import type { WithTeam } from "../src/with-team.ts";

/** The steps only slice 8b builds: the daily expiry job. */
const SLICE_8B_STEPS = new Set(["expire"]);

/** Whether the runner runs a case now, or lists it as todo: only a case with a slice 8b step waits. */
export function planCase(c: ReconcileCase): { run: true } | { run: false; todo: string } {
  const waiting = [
    ...new Set(c.steps.map((step) => step.step).filter((step) => SLICE_8B_STEPS.has(step))),
  ];
  if (waiting.length === 0) return { run: true };
  return { run: false, todo: `needs slice 8b for its ${waiting.join(" and ")} step` };
}

type DecisionStep = Extract<ReconcileStep, { step: "decision" }>;

/** A case's decision step through the Findings module's named call, its refs resolved to Finding ids. */
function decide(
  findings: Findings,
  team: string,
  step: DecisionStep,
  resolve: (ref: FindingRef) => string,
) {
  const id = resolve(step.finding);
  const input = { actor: step.actor, reason: step.reason };
  switch (step.decision) {
    case "accept":
      return findings.accept(team, id, { ...input, until: step.until! });
    case "mark_false_positive":
      return findings.markFalsePositive(team, id, input);
    case "confirm_fix":
      return findings.confirmFix(team, id, input);
    case "mark_moved":
      return findings.markMoved(team, id, { ...input, candidate: resolve(step.candidate!) });
    case "reopen":
      return findings.reopen(team, id, input);
  }
}

/** The case with every `team` field set to `team`: history can't be deleted, so each case gets a Team of its own. */
export function withTeamId<T>(value: T, team: string): T {
  if (Array.isArray(value)) return value.map((item) => withTeamId(item, team)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      key === "team" ? team : withTeamId(field, team),
    ]),
  ) as T;
}

/** Each expected Finding's checked fields, and the same fields of the Finding the Team has, keyed by Finding id. */
export interface CaseResult {
  expected: Record<string, Record<string, unknown>>;
  actual: Record<string, Record<string, unknown>>;
}

export async function runCase(
  original: ReconcileCase,
  { findings, withTeam }: { findings: Findings; withTeam: WithTeam },
): Promise<CaseResult> {
  const team = `org_case_${randomUUID()}`;
  const c = withTeamId(original, team);

  await withTeam(team, async (tx) => {
    await tx.insertInto("teams").values({ id: team }).execute();
    // A decision is a Lead's (rechecked under the Team's lock): each person a case names decides as one.
    const people = new Set(
      c.steps.flatMap((step) => (step.step === "decision" ? [step.actor.id] : [])),
    );
    for (const user_id of people) {
      await tx
        .insertInto("team_members")
        .values({ team_id: team, user_id, role: "lead" })
        .execute();
    }
    if (c.given.findings.length > 0) {
      await tx.insertInto("findings").values(c.given.findings.map(toRow)).execute();
    }
  });

  const labels = new Map<string, string>();
  const resolve = (ref: FindingRef) => ("id" in ref ? ref.id : labels.get(ref.new)!);
  for (const [i, step] of c.steps.entries()) {
    if (step.step === "decision") {
      await decide(findings, team, step, resolve);
      continue;
    }
    if (step.step !== "scan" && step.step !== "spot_run") {
      throw new Error(`step ${i} is a ${step.step} step, which needs slice 8b`);
    }
    const outcome =
      step.step === "scan"
        ? await findings.reconcile(step.scan)
        : await findings.report(step.spot_run);
    for (const [label, index] of Object.entries(step.labels ?? {})) {
      const opened = outcome.opened.find((o) => o.observation === index);
      if (!opened) {
        throw new Error(`step ${i}: the Observation labelled "${label}" (${index}) opened nothing`);
      }
      labels.set(label, opened.id);
    }
  }

  const listed = new Map((await findings.list(team)).map((finding) => [finding.id, finding]));
  const result: CaseResult = { expected: {}, actual: {} };
  for (const expectation of c.expect) {
    const id = resolve(
      expectation.id !== undefined ? { id: expectation.id } : { new: expectation.new! },
    );
    result.expected[id] = checkedFields(expectation, resolve);
    const finding = listed.get(id);
    result.actual[id] = finding
      ? pick(finding, Object.keys(result.expected[id]))
      : { missing: "the Team has no such Finding" };
  }
  for (const [id, finding] of listed) {
    result.actual[id] ??= {
      unexpected: `a Finding the case doesn't expect: ${finding.fingerprint}`,
    };
  }
  return result;
}

/** An expectation's fields, without its ref, with the refs inside it resolved to Finding ids. */
function checkedFields(
  expectation: ExpectedFinding,
  resolve: (ref: FindingRef) => string,
): Record<string, unknown> {
  const { unconfirmed_fix, moved_to, ...rest } = expectation;
  const fields = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key !== "id" && key !== "new"),
  );
  return {
    ...fields,
    ...(unconfirmed_fix !== undefined && {
      unconfirmed_fix: unconfirmed_fix && { candidates: unconfirmed_fix.candidates.map(resolve) },
    }),
    ...(moved_to !== undefined && { moved_to: moved_to && resolve(moved_to) }),
  };
}

function pick(finding: Finding, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, finding[key as keyof Finding]]));
}
