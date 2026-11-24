// A reconcile case as data (ADR 0005: contracts stay language-neutral): what exists, what happens, what should
// exist after. Slice 7's runner applies them to `reconcile`; the README states the format.
import { z } from "zod";
import {
  checkFindingFields,
  contractsRegistry,
  DateTime,
  Finding,
  FindingFields,
  Id,
  problemKey,
  Scan,
  SpotRun,
  Text,
} from "./finding.ts";

/** Who made a change: a person or an agent. */
export const Actor = z.strictObject({
  kind: z.enum(["person", "agent"]),
  id: Id,
});
export type Actor = z.infer<typeof Actor>;

/** Names a Finding a step created, since the implementation chooses new ids. */
const Label = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "a label is lower-case letters, digits, - and _");

/** A Finding in a case: `{ id }` for one in `given`, `{ new: label }` for one a step created. */
export const FindingRef = z.union([z.strictObject({ id: Id }), z.strictObject({ new: Label })]);
export type FindingRef = z.infer<typeof FindingRef>;

const sameRef = (a: FindingRef, b: FindingRef) => JSON.stringify(a) === JSON.stringify(b);

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
    reason: Text(2000),
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
    if (step.candidate && sameRef(step.candidate, step.finding)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "a Finding is merged into another Finding, never itself",
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

/**
 * One Finding after the steps: a ref (`id` or `new`) plus only the fields the case checks, each as a Finding has
 * it, and held to the Finding rules among the fields given.
 */
export const ExpectedFinding = FindingFields.partial()
  .extend({
    new: Label.optional(),
    /** Its candidates are refs, since new Findings' ids aren't known in advance. */
    unconfirmed_fix: z
      .strictObject({ candidates: z.array(FindingRef).min(1) })
      .nullable()
      .optional(),
    moved_to: FindingRef.nullable().optional(),
  })
  .superRefine((expected, ctx) => {
    if ((expected.id === undefined) === (expected.new === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "an expected Finding is named by exactly one of id (from given) or new (a label)",
      });
      return;
    }
    checkFindingFields(expected, ctx);
    const self: FindingRef =
      expected.id !== undefined ? { id: expected.id } : { new: expected.new! };
    if (expected.moved_to && sameRef(expected.moved_to, self)) {
      ctx.addIssue({
        code: "custom",
        path: ["moved_to"],
        message: "a Finding is merged into another Finding, never itself",
      });
    }
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
    /** The label already on each problem (module, Asset and Fingerprint): one problem opens at most one Finding. */
    const labelOfProblem = new Map<string, string>();
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
        const run = step.step === "scan" ? step.scan : step.spot_run;
        const observations = run.observations;
        const labelled = new Map<number, string>();
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
          const other = labelled.get(index);
          if (other !== undefined) {
            ctx.addIssue({
              code: "custom",
              path,
              message: `the Observation at index ${index} already has the label "${other}"`,
            });
          }
          const observation = observations[index];
          if (observation) {
            const problem = JSON.stringify([run.module, problemKey(observation)]);
            const earlier = labelOfProblem.get(problem);
            if (earlier !== undefined && earlier !== other) {
              ctx.addIssue({
                code: "custom",
                path,
                message: `the label "${earlier}" already names this problem (Asset, module and Fingerprint): one problem opens at most one Finding`,
              });
            }
            labelOfProblem.set(problem, earlier ?? label);
          }
          labelled.set(index, label);
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
