// Finding v1 (ADR 0005) and what a module hands over: one zod schema gives the type, the check and the JSON Schema.
// Every object is strict, so a field the format doesn't name (a secret's value, an event's raw content, a Status on
// an Observation) is refused rather than dropped. The rules between fields live in the refinements below; JSON
// Schema carries the shapes only (see the README).
import { z } from "zod";
import { fingerprint } from "./fingerprint.ts";

/**
 * The schemas that become named `$defs` in the published JSON Schema. A registry of this package's own, not zod's
 * global one, so evaluating the module twice (a dev server's reload) can't clash on an id.
 */
export const contractsRegistry = z.registry<{ id: string; description?: string }>();

export const Module = z.enum(["guard", "patch", "vouch"]);
export type Module = z.infer<typeof Module>;

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Status = z.enum(["open", "fixed", "accepted", "false_positive"]);
export type Status = z.infer<typeof Status>;

/** An id Warden or a module gave: a Finding, a Team, a Scan or a Spot run. */
const Id = z.string().min(1).max(200);

/** An ISO 8601 date-time, with `Z` or an offset. */
export const DateTime = z.iso.datetime({ offset: true });

/** A Rule id starts with its module and a slash, such as `guard/agent-can-read-env`. No `|`, which the Fingerprint uses. */
export const RuleId = z
  .string()
  .max(200)
  .regex(
    /^(guard|patch|vouch)\/[^\s|]+$/,
    "a Rule id starts with its module and a slash, such as guard/agent-can-read-env",
  );
export type RuleId = z.infer<typeof RuleId>;

/** The glossary's closed list; a new kind needs an ADR. */
export const AssetKind = z.enum(["repo", "product", "device", "agent_session"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const Asset = z
  .strictObject({ kind: AssetKind, ref: z.string().min(1).max(2000) })
  .register(contractsRegistry, { id: "Asset", description: "The thing a Finding is about." });
export type Asset = z.infer<typeof Asset>;

/** A path relative to its Asset: not absolute, and without a `..` part. */
const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) => !/^([/\\]|[A-Za-z]:)/.test(path),
    "a path is relative to its Asset, never absolute",
  )
  .refine((path) => !path.split(/[/\\]/).includes(".."), "a path has no `..` part");

export const Location = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("file"),
      path: RelativePath,
      line: z.int().min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal("dependency"),
      package: z.string().min(1).max(214),
      version: z.string().min(1).max(100),
      /** Such as a CVE id. */
      vulnerability: z.string().min(1).max(100).optional(),
    }),
    /** A Device's setting. */
    z.strictObject({ kind: z.literal("setting"), name: z.string().min(1).max(200) }),
    /** An Agent session, as a whole. */
    z.strictObject({ kind: z.literal("session") }),
  ])
  .register(contractsRegistry, {
    id: "Location",
    description: "Where on its Asset the problem sits.",
  });
export type Location = z.infer<typeof Location>;

/** At most 4 characters of the value show; the rest are `*`. */
const Mask = z
  .string()
  .min(1)
  .max(256)
  .refine((mask) => mask.includes("*"), "a mask hides the value with `*`")
  .refine(
    (mask) => mask.replaceAll("*", "").length <= 4,
    "a mask shows at most 4 characters of the value",
  );

/** Where a secret sits and what kind it is. There is no field for its value. */
export const SecretEvidence = z
  .strictObject({
    type: z.string().min(1).max(100),
    path: RelativePath,
    line: z.int().min(1),
    mask: Mask,
  })
  .register(contractsRegistry, {
    id: "SecretEvidence",
    description: "A secret's type, path, line and mask; never its value.",
  });
export type SecretEvidence = z.infer<typeof SecretEvidence>;

/** One Agent event as the Judge read it, redacted. There is no field for the event's raw content. */
export const MaskedAgentEvent = z
  .strictObject({
    /** Its 0-based position among the events the Judge read. */
    seq: z.int().min(0),
    at: DateTime,
    /** The hook event name, such as `PreToolUse`. */
    name: z.string().min(1).max(64),
    tool: z.string().min(1).max(128).optional(),
    /** The redacted content, at the Team's Privacy tier. */
    text: z.string().max(4000),
  })
  .register(contractsRegistry, {
    id: "MaskedAgentEvent",
    description: "One redacted Agent event the Judge relied on.",
  });
export type MaskedAgentEvent = z.infer<typeof MaskedAgentEvent>;

export const EventsHash = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "`sha256:` and 64 lower-case hex digits");

/** What a Judge's Finding keeps of an Agent session after its events are dropped (ADR 0007, threat J8). */
export const SessionEvidence = z
  .strictObject({
    events: z.array(MaskedAgentEvent).min(1).max(50),
    events_read: z.int().min(1),
    /** `agentEventsHash()` of every redacted event the Judge read, in order. */
    events_hash: EventsHash,
  })
  .superRefine((evidence, ctx) => {
    evidence.events.forEach((event, i) => {
      const previous = evidence.events[i - 1];
      if (previous && event.seq <= previous.seq) {
        ctx.addIssue({
          code: "custom",
          path: ["events", i, "seq"],
          message: "events are kept in session order: seq strictly increases",
        });
      }
    });
    const last = evidence.events.at(-1);
    if (
      evidence.events_read < evidence.events.length ||
      (last && evidence.events_read <= last.seq)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["events_read"],
        message:
          "events_read counts every event the Judge read: at least the events kept, and above the last seq",
      });
    }
  })
  .register(contractsRegistry, {
    id: "SessionEvidence",
    description: "The masked events a Judge relied on, and a hash of all it read.",
  });
export type SessionEvidence = z.infer<typeof SessionEvidence>;

export const Evidence = z
  .strictObject({
    summary: z.string().min(1).max(2000),
    secret: SecretEvidence.optional(),
    /** Required on an Agent session Finding, refused on any other. */
    session: SessionEvidence.optional(),
  })
  .register(contractsRegistry, {
    id: "Evidence",
    description: "Why the module raised it. Never a secret's value or an event's raw content.",
  });
export type Evidence = z.infer<typeof Evidence>;

/** A Control in one Catalogue, set only once Vouch maps the Finding. */
export const Control = z.strictObject({
  catalogue: z.string().min(1).max(200),
  ref: z.string().min(1).max(200),
});
export type Control = z.infer<typeof Control>;

/** The rules a Finding and an Observation share: the Asset, Location and session evidence go together. */
function checkProblem(
  problem: { asset: Asset; location: Location; evidence: Evidence },
  ctx: z.RefinementCtx,
): void {
  const onSession = problem.asset.kind === "agent_session";
  if (onSession !== (problem.location.kind === "session")) {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message:
        "a session Location goes only with an agent_session Asset, and an agent_session Asset only with a session Location",
    });
  }
  if (onSession && !problem.evidence.session) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence", "session"],
      message: "an Agent session's evidence keeps the masked events the Judge relied on",
    });
  }
  if (!onSession && problem.evidence.session) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence", "session"],
      message: "only an Agent session's evidence has session events",
    });
  }
}

export const UnconfirmedFix = z.strictObject({
  /** The ids of the new Findings that may be this one moved. */
  candidates: z.array(Id).min(1),
});

/** Finding v1: one observed problem with one Asset, raised by one module. Read-only once parsed (ADR 0005). */
export const Finding = z
  .strictObject({
    // Identity
    id: Id,
    team: Id,
    asset: Asset,
    module: Module,
    rule_id: RuleId,
    fingerprint: z.string().min(1).max(4000),
    location: Location,
    // Judgement
    severity: Severity,
    title: z.string().min(1).max(200),
    evidence: Evidence,
    control: Control.optional(),
    // Lifecycle
    status: Status,
    unconfirmed_fix: UnconfirmedFix.nullable(),
    accepted_reason: z.string().min(1).max(2000).nullable(),
    accepted_until: DateTime.nullable(),
    /** The id of the Scan or Spot run that first saw it. */
    first_seen_scan: Id,
    /** The id of the Scan or Spot run that last saw it. */
    last_seen_scan: Id,
    /** Set on a Finding a person merged into another (mark moved): that Finding's id. */
    moved_to: Id.nullable(),
  })
  .superRefine((finding, ctx) => {
    if (!finding.rule_id.startsWith(`${finding.module}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["rule_id"],
        message: `a ${finding.module} Finding's Rule id starts with "${finding.module}/"`,
      });
    }
    checkProblem(finding, ctx);
    const expected = fingerprint(finding.rule_id, finding.location);
    if (finding.fingerprint !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: `the Fingerprint of this Rule and Location is "${expected}"`,
      });
    }
    const accepted = finding.status === "accepted";
    if (accepted !== (finding.accepted_reason !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["accepted_reason"],
        message: "accepted_reason is set exactly when the status is accepted",
      });
    }
    if (accepted !== (finding.accepted_until !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["accepted_until"],
        message: "accepted_until is set exactly when the status is accepted",
      });
    }
    if (finding.unconfirmed_fix !== null && finding.status !== "fixed") {
      ctx.addIssue({
        code: "custom",
        path: ["unconfirmed_fix"],
        message: "only a Fixed Finding can be an Unconfirmed fix",
      });
    }
  })
  .readonly()
  .register(contractsRegistry, {
    id: "Finding",
    description: "Finding v1: one observed problem with one Asset, raised by one module.",
  });
export type Finding = z.infer<typeof Finding>;

/**
 * One thing a Scan or Spot run saw. Strict: a module can't hand over a Status, a Fingerprint, an id or history.
 */
export const Observation = z
  .strictObject({
    asset: Asset,
    rule_id: RuleId,
    location: Location,
    severity: Severity,
    title: z.string().min(1).max(200),
    evidence: Evidence,
  })
  .superRefine(checkProblem)
  .register(contractsRegistry, {
    id: "Observation",
    description: "One thing a Scan or Spot run saw.",
  });
export type Observation = z.infer<typeof Observation>;

const assetKey = (asset: Asset) => `${asset.kind}:${asset.ref}`;

function checkObservedRules(
  run: { module: Module; observations: Observation[] },
  ctx: z.RefinementCtx,
): void {
  run.observations.forEach((observation, i) => {
    if (!observation.rule_id.startsWith(`${run.module}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["observations", i, "rule_id"],
        message: `a ${run.module} run reports only ${run.module}'s Rules`,
      });
    }
  });
}

/** What `reconcile(scan)` takes: what one Scan covered and what it saw. */
export const Scan = z
  .strictObject({
    id: Id,
    team: Id,
    module: Module,
    started_at: DateTime,
    /** The Assets it covered. */
    assets: z.array(Asset).min(1),
    /** The Rules it covered. */
    rules: z.array(RuleId).min(1),
    observations: z.array(Observation),
  })
  .superRefine((scan, ctx) => {
    scan.assets.forEach((asset, i) => {
      if (asset.kind === "agent_session") {
        ctx.addIssue({
          code: "custom",
          path: ["assets", i],
          message: "an Agent session is never rescanned: only a Spot run reports on one",
        });
      }
    });
    scan.rules.forEach((rule, i) => {
      if (!rule.startsWith(`${scan.module}/`)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i],
          message: `a ${scan.module} Scan covers only ${scan.module}'s Rules`,
        });
      }
    });
    const covered = new Set(scan.assets.map(assetKey));
    scan.observations.forEach((observation, i) => {
      if (!covered.has(assetKey(observation.asset))) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", i, "asset"],
          message: "an Observation's Asset is one the Scan covered",
        });
      }
      if (!scan.rules.includes(observation.rule_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", i, "rule_id"],
          message: "an Observation's Rule is one the Scan covered",
        });
      }
    });
  })
  .register(contractsRegistry, {
    id: "Scan",
    description:
      "One run of a Baseline over some of a Team's Assets: what it covered and what it saw.",
  });
export type Scan = z.infer<typeof Scan>;

/** What `report(...)` takes. A Spot run covers nothing, so it never marks a Finding Fixed. */
export const SpotRun = z
  .strictObject({
    id: Id,
    team: Id,
    module: Module,
    started_at: DateTime,
    observations: z.array(Observation),
  })
  .superRefine(checkObservedRules)
  .register(contractsRegistry, {
    id: "SpotRun",
    description: "A run outside the Baseline: it can open Findings but never marks one Fixed.",
  });
export type SpotRun = z.infer<typeof SpotRun>;
