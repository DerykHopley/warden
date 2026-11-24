// A reconcile case as data (ADR 0005: contracts stay language-neutral): what exists, what happens, what should
// exist after. Slice 7's runner applies them to `reconcile`; the README states the format.
import { z } from "zod";
import {
  Asset,
  Control,
  contractsRegistry,
  DateTime,
  Evidence,
  Finding,
  Location,
  Module,
  RuleId,
  Scan,
  Severity,
  SpotRun,
  Status,
} from "./finding.ts";

/** Who made a change: a person or an agent. */
export const Actor = z.strictObject({
  kind: z.enum(["person", "agent"]),
  id: z.string().min(1).max(200),
});
export type Actor = z.infer<typeof Actor>;

/** Names a Finding a step created, since the implementation chooses new ids. */
const Label = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "a label is lower-case letters, digits, - and _");

/** A Finding in a case: `{ id }` for one in `given`, `{ new: label }` for one a step created. */
export const FindingRef = z.union([
  z.strictObject({ id: z.string().min(1) }),
  z.strictObject({ new: Label }),
]);
export type FindingRef = z.infer<typeof FindingRef>;

/** Each label names the new Finding the Observation at that index opens. */
const Labels = z.record(Label, z.int().min(0));

const ScanStep = z.strictObject({ step: z.literal("scan"), scan: Scan, labels: Labels.optional() });
const SpotRunStep = z.strictObject({
  step: z.literal("spot_run"),
  spot_run: SpotRun,
  labels: Labels.optional(),
});

const DecisionStep = z
  .strictObject({
    step: z.literal("decision"),
    decision: z.enum(["accept", "mark_false_positive", "confirm_fix", "mark_moved", "reopen"]),
    finding: FindingRef,
    actor: Actor,
    reason: z.string().min(1).max(2000),
    /** `accept` only: when the acceptance expires. */
    until: DateTime.optional(),
    /** `mark_moved` only: the new Finding that merges into `finding`. */
    candidate: FindingRef.optional(),
  })
  .superRefine((step, ctx) => {
    if (step.actor.kind !== "person") {
      ctx.addIssue({
        code: "custom",
        path: ["actor"],
        message: "a decision needs a person: an agent only proposes",
      });
    }
    if ((step.decision === "accept") !== (step.until !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["until"],
        message: "until is given exactly on an accept",
      });
    }
    if ((step.decision === "mark_moved") !== (step.candidate !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "candidate is given exactly on a mark_moved",
      });
    }
  });

/** The daily job that reopens Accepted Findings whose expiry has passed. */
const ExpireStep = z.strictObject({ step: z.literal("expire"), now: DateTime });

export const ReconcileStep = z.discriminatedUnion("step", [
  ScanStep,
  SpotRunStep,
  DecisionStep,
  ExpireStep,
]);
export type ReconcileStep = z.infer<typeof ReconcileStep>;

/** One Finding after the steps: a ref (`id` or `new`) plus only the fields the case checks. */
export const ExpectedFinding = z
  .strictObject({
    id: z.string().min(1).optional(),
    new: Label.optional(),
    team: z.string().min(1).optional(),
    asset: Asset.optional(),
    module: Module.optional(),
    rule_id: RuleId.optional(),
    fingerprint: z.string().min(1).optional(),
    location: Location.optional(),
    severity: Severity.optional(),
    title: z.string().min(1).optional(),
    evidence: Evidence.optional(),
    control: Control.optional(),
    status: Status.optional(),
    /** Its candidates are refs, since new Findings' ids aren't known in advance. */
    unconfirmed_fix: z
      .strictObject({ candidates: z.array(FindingRef).min(1) })
      .nullable()
      .optional(),
    accepted_reason: z.string().min(1).nullable().optional(),
    accepted_until: DateTime.nullable().optional(),
    first_seen_scan: z.string().min(1).optional(),
    last_seen_scan: z.string().min(1).optional(),
    moved_to: FindingRef.nullable().optional(),
  })
  .refine((expected) => (expected.id === undefined) !== (expected.new === undefined), {
    message: "an expected Finding is named by exactly one of id (from given) or new (a label)",
  });
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

export const ReconcileCase = z
  .strictObject({
    name: z.string().min(1).max(200),
    /** The glossary or ADR 0005 sentence the case checks, quoted. */
    rule: z.string().min(1).max(2000),
    given: z.strictObject({ now: DateTime, findings: z.array(Finding) }),
    steps: z.array(ReconcileStep).min(1),
    /** Every Finding the Team has after the steps. */
    expect: z.array(ExpectedFinding),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.given.findings.forEach((finding, i) => {
      if (ids.has(finding.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["given", "findings", i, "id"],
          message: `"${finding.id}" is given twice`,
        });
      }
      ids.add(finding.id);
    });

    const labels = new Set<string>();
    const checkRef = (ref: FindingRef, path: (string | number)[]) => {
      if ("id" in ref && !ids.has(ref.id)) {
        ctx.addIssue({ code: "custom", path, message: `no Finding "${ref.id}" is given` });
      }
      if ("new" in ref && !labels.has(ref.new)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `no earlier step created the label "${ref.new}"`,
        });
      }
    };

    c.steps.forEach((step, i) => {
      if (step.step === "decision") {
        checkRef(step.finding, ["steps", i, "finding"]);
        if (step.candidate) checkRef(step.candidate, ["steps", i, "candidate"]);
      }
      if (step.step === "scan" || step.step === "spot_run") {
        const observations =
          step.step === "scan" ? step.scan.observations : step.spot_run.observations;
        for (const [label, index] of Object.entries(step.labels ?? {})) {
          const path = ["steps", i, "labels", label];
          if (labels.has(label))
            ctx.addIssue({
              code: "custom",
              path,
              message: `the label "${label}" is created twice`,
            });
          if (index >= observations.length) {
            ctx.addIssue({
              code: "custom",
              path,
              message: `the step has no Observation at index ${index}`,
            });
          }
          labels.add(label);
        }
      }
    });

    const named = new Set<string>();
    c.expect.forEach((expected, i) => {
      const key = expected.id !== undefined ? "id" : "new";
      const ref: FindingRef =
        expected.id !== undefined ? { id: expected.id } : { new: expected.new! };
      checkRef(ref, ["expect", i, key]);
      const refKey = JSON.stringify(ref);
      if (named.has(refKey))
        ctx.addIssue({
          code: "custom",
          path: ["expect", i, key],
          message: "this Finding is expected twice",
        });
      named.add(refKey);
      expected.unconfirmed_fix?.candidates.forEach((candidate, j) =>
        checkRef(candidate, ["expect", i, "unconfirmed_fix", "candidates", j]),
      );
      if (expected.moved_to) checkRef(expected.moved_to, ["expect", i, "moved_to"]);
    });
  })
  .register(contractsRegistry, {
    id: "ReconcileCase",
    description:
      "One reconcile case: given Findings, steps applied in order, the Findings expected after.",
  });
export type ReconcileCase = z.infer<typeof ReconcileCase>;
