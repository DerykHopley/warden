// Finding v1 (ADR 0005) and what a module hands over: one zod schema gives the type, the check and the JSON Schema.
// Every object is strict, so a field the format doesn't name (a secret's value, an event's raw content, a Status on
// an Observation) is refused rather than dropped. Rules on one string are regex patterns, so the JSON Schema carries
// them too; the rules between fields live in the refinements below and the README.
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

/** Each Status as people read it (GLOSSARY.md): the dashboard's labels and the server's refusals. */
export const STATUS_WORDS: Readonly<Record<Status, string>> = {
  open: "Open",
  fixed: "Fixed",
  accepted: "Accepted",
  false_positive: "False positive",
};

/** An id Warden or a module gave: a Finding, a Team, a Scan or a Spot run. */
export const Id = z.string().min(1).max(200);

/** Who made a change: a person or an agent. */
export const Actor = z.strictObject({
  kind: z.enum(["person", "agent"]),
  id: Id,
});
export type Actor = z.infer<typeof Actor>;

/**
 * Text a person reads: at least one character that isn't whitespace. A pattern, so the JSON Schema carries it, and an
 * explicit class rather than `\S`, whose meaning differs between regex engines (Rust's `\s` leaves out U+FEFF). The
 * README lists the same characters: JavaScript's `\s`.
 */
export const BLANK_CODE_POINTS: readonly (readonly [number] | readonly [number, number])[] = [
  [0x0009, 0x000d], // tab, line feed, vertical tab, form feed, carriage return
  [0x0020], // space
  [0x00a0], // no-break space
  [0x1680], // Ogham space mark
  [0x2000, 0x200a], // en quad to hair space
  [0x2028], // line separator
  [0x2029], // paragraph separator
  [0x202f], // narrow no-break space
  [0x205f], // medium mathematical space
  [0x3000], // ideographic space
  [0xfeff], // byte order mark
];

/** A code point as a regex escape of exactly four hex digits, which JavaScript, Rust and Python all read. */
const escape = (codePoint: number) => `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

export const NOT_BLANK = new RegExp(
  `[^${BLANK_CODE_POINTS.map((range) => range.map(escape).join("-")).join("")}]`,
);
const NOT_BLANK_MESSAGE = "holds at least one character that isn't whitespace";

/** Free text a person reads, of at most `max` characters, never only whitespace. */
export const Text = (max: number) => z.string().min(1).max(max).regex(NOT_BLANK, NOT_BLANK_MESSAGE);

export const Title = Text(200);

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

/** Whether a Rule id is the given module's own. */
export function ruleBelongsTo(module: Module, ruleId: string): boolean {
  return ruleId.startsWith(`${module}/`);
}

/** The glossary's closed list; a new kind needs an ADR. */
export const AssetKind = z.enum(["repo", "product", "device", "agent_session"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const Asset = z
  .strictObject({ kind: AssetKind, ref: z.string().min(1).max(2000) })
  .readonly()
  .register(contractsRegistry, { id: "Asset", description: "The thing a Finding is about." });
export type Asset = z.infer<typeof Asset>;

/** One part of a path: not empty, not `.` or `..`, with no `/` or `\`. */
const PATH_PART = String.raw`(?:[^/\\.][^/\\]*|\.[^/\\.][^/\\]*|\.\.[^/\\]+)`;

/**
 * A path relative to its Asset, with one spelling per file so one file has one Fingerprint: parts joined by `/`,
 * none empty, `.` or `..`, no `\`, and no drive letter followed by `/`. Both rules are patterns, so the JSON Schema
 * carries them, and neither uses lookaround, so Rust's `regex` crate runs them as they are.
 */
const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    new RegExp(`^${PATH_PART}(?:/${PATH_PART})*$`),
    "a path is relative to its Asset: parts joined by /, none empty, . or .., and no \\",
  )
  .regex(
    /^(?:[^A-Za-z]|[A-Za-z](?:[^:]|$)|[A-Za-z]:(?:[^/\\]|$))/,
    "a path is relative to its Asset, never on a drive such as C:/",
  );

/** A Fingerprint part: no `|`, which the Fingerprint uses to join its parts. */
const FingerprintPart = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^|]+$/, "no |, which the Fingerprint uses to join its parts");

export const Location = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("file"),
      path: RelativePath,
      line: z.int().min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal("dependency"),
      package: FingerprintPart(214),
      version: z.string().min(1).max(100),
      /** Such as a CVE id. */
      vulnerability: FingerprintPart(100).optional(),
    }),
    /** A Device's setting. */
    z.strictObject({ kind: z.literal("setting"), name: FingerprintPart(200) }),
    /** An Agent session, as a whole. */
    z.strictObject({ kind: z.literal("session") }),
  ])
  .readonly()
  .register(contractsRegistry, {
    id: "Location",
    description: "Where on its Asset the problem sits.",
  });
export type Location = z.infer<typeof Location>;

/** Hides the value with `*` and shows at most 4 of its characters. Two patterns, so the JSON Schema carries both. */
const Mask = z
  .string()
  .min(1)
  .max(256)
  .regex(/\*/, "a mask hides the value with `*`")
  .regex(/^\**(?:[^*]\**){0,4}$/, "a mask shows at most 4 characters of the value");

/** Where a secret sits and what kind it is. There is no field for its value. */
export const SecretEvidence = z
  .strictObject({
    type: z.string().min(1).max(100),
    path: RelativePath,
    line: z.int().min(1),
    mask: Mask,
  })
  .readonly()
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
  .readonly()
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
    events: z.array(MaskedAgentEvent).min(1).max(50).readonly(),
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
  .readonly()
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
  .readonly()
  .register(contractsRegistry, {
    id: "Evidence",
    description: "Why the module raised it. Never a secret's value or an event's raw content.",
  });
export type Evidence = z.infer<typeof Evidence>;

/** A Control in one Catalogue, set only once Vouch maps the Finding. */
export const Control = z
  .strictObject({
    catalogue: z.string().min(1).max(200),
    ref: z.string().min(1).max(200),
  })
  .readonly();
export type Control = z.infer<typeof Control>;

export const UnconfirmedFix = z
  .strictObject({
    /** The ids of the new Findings that may be this one moved. */
    candidates: z.array(Id).min(1).readonly(),
  })
  .readonly();

/**
 * The rules an Asset, Location and Evidence keep together, on a Finding, an Observation or an expected Finding. A
 * rule runs only when the fields it pairs are present.
 */
function checkProblem(
  problem: {
    asset?: Asset | undefined;
    location?: Location | undefined;
    evidence?: Evidence | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (!problem.asset) return;
  const onSession = problem.asset.kind === "agent_session";
  if (problem.location && onSession !== (problem.location.kind === "session")) {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message:
        "a session Location goes only with an agent_session Asset, and an agent_session Asset only with a session Location",
    });
  }
  if (problem.evidence && onSession && !problem.evidence.session) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence", "session"],
      message: "an Agent session's evidence keeps the masked events the Judge relied on",
    });
  }
  if (problem.evidence && !onSession && problem.evidence.session) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence", "session"],
      message: "only an Agent session's evidence has session events",
    });
  }
}

/** A Finding's fields, before the rules between them: `Finding` adds them, and a case's expectation reuses both. */
export const FindingFields = z.strictObject({
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
  title: Title,
  evidence: Evidence,
  control: Control.optional(),
  // Lifecycle
  status: Status,
  unconfirmed_fix: UnconfirmedFix.nullable(),
  accepted_reason: Text(2000).nullable(),
  accepted_until: DateTime.nullable(),
  /** The id of the Scan or Spot run that first saw it. */
  first_seen_scan: Id,
  /** The id of the Scan or Spot run that last saw it. */
  last_seen_scan: Id,
  /** Set on a Finding a person merged into another (mark moved): that Finding's id. It is then Fixed. */
  moved_to: Id.nullable(),
});

/** The fields the Finding rules read; each rule runs only when the fields it relates are present. */
export interface CheckedFindingFields {
  asset?: Asset | undefined;
  module?: Module | undefined;
  rule_id?: string | undefined;
  fingerprint?: string | undefined;
  location?: Location | undefined;
  evidence?: Evidence | undefined;
  status?: Status | undefined;
  unconfirmed_fix?: unknown;
  accepted_reason?: string | null | undefined;
  accepted_until?: string | null | undefined;
  moved_to?: unknown;
}

/** The rules between a Finding's fields. A missing field skips the rules it takes part in. */
export function checkFindingFields(finding: CheckedFindingFields, ctx: z.RefinementCtx): void {
  if (
    finding.module !== undefined &&
    finding.rule_id !== undefined &&
    !ruleBelongsTo(finding.module, finding.rule_id)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["rule_id"],
      message: `a ${finding.module} Finding's Rule id starts with "${finding.module}/"`,
    });
  }
  checkProblem(finding, ctx);
  if (finding.rule_id !== undefined && finding.location && finding.fingerprint !== undefined) {
    const expected = fingerprint(finding.rule_id, finding.location);
    if (finding.fingerprint !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: `the Fingerprint of this Rule and Location is "${expected}"`,
      });
    }
  }
  if (finding.status === undefined) return;
  const accepted = finding.status === "accepted";
  if (finding.accepted_reason !== undefined && accepted !== (finding.accepted_reason !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["accepted_reason"],
      message: "accepted_reason is set exactly when the status is accepted",
    });
  }
  if (finding.accepted_until !== undefined && accepted !== (finding.accepted_until !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["accepted_until"],
      message: "accepted_until is set exactly when the status is accepted",
    });
  }
  const fixed = finding.status === "fixed";
  if (finding.unconfirmed_fix != null && !fixed) {
    ctx.addIssue({
      code: "custom",
      path: ["unconfirmed_fix"],
      message: "only a Fixed Finding can be an Unconfirmed fix",
    });
  }
  if (finding.moved_to != null && !fixed) {
    ctx.addIssue({
      code: "custom",
      path: ["moved_to"],
      message: "a Finding merged into another is closed as Fixed",
    });
  }
}

/** Finding v1: one observed problem with one Asset, raised by one module. Read-only once parsed (ADR 0005). */
export const Finding = FindingFields.superRefine((finding, ctx) => {
  checkFindingFields(finding, ctx);
  if (finding.moved_to === finding.id) {
    ctx.addIssue({
      code: "custom",
      path: ["moved_to"],
      message: "a Finding is merged into another Finding, never itself",
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
    title: Title,
    evidence: Evidence,
  })
  .superRefine(checkProblem)
  .register(contractsRegistry, {
    id: "Observation",
    description: "One thing a Scan or Spot run saw.",
  });
export type Observation = z.infer<typeof Observation>;

/** An Asset as one string, for lookups: TypeScript has no value equality (ADR 0005). A kind holds no `:`. */
export const assetKey = (asset: Asset) => `${asset.kind}:${asset.ref}`;

/** One problem as one string: an Asset and a Fingerprint. Reconcile matches a Finding by it. */
export const problemKeyOf = (asset: Asset, fingerprintValue: string) =>
  JSON.stringify([asset.kind, asset.ref, fingerprintValue]);

/** The problem an Observation reports. A run reports each problem once (the README's "one problem, once"). */
export const problemKey = (observation: Pick<Observation, "asset" | "rule_id" | "location">) =>
  problemKeyOf(observation.asset, fingerprint(observation.rule_id, observation.location));

/** Refuses an item equal (by `key`) to an earlier one, on the later one's index, naming the earlier index. */
function refuseRepeats<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  message: (earlier: string) => string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  items.forEach((item, i) => {
    const earlier = seen.get(key(item));
    if (earlier !== undefined) {
      ctx.addIssue({ code: "custom", path: [field, i], message: message(`${field}[${earlier}]`) });
    } else {
      seen.set(key(item), i);
    }
  });
}

const sameProblem = (earlier: string) =>
  `the same problem (Asset and Fingerprint) as ${earlier}: a run reports each problem once`;

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
      if (!ruleBelongsTo(scan.module, rule)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i],
          message: `a ${scan.module} Scan covers only ${scan.module}'s Rules`,
        });
      }
    });
    const listedOnce = (what: string) => (earlier: string) =>
      `the same ${what} as ${earlier}: each is listed once`;
    refuseRepeats(scan.assets, assetKey, "assets", listedOnce("Asset"), ctx);
    refuseRepeats(scan.rules, (rule) => rule, "rules", listedOnce("Rule"), ctx);
    refuseRepeats(scan.observations, problemKey, "observations", sameProblem, ctx);
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
  .superRefine((run, ctx) => {
    refuseRepeats(run.observations, problemKey, "observations", sameProblem, ctx);
    run.observations.forEach((observation, i) => {
      if (!ruleBelongsTo(run.module, observation.rule_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", i, "rule_id"],
          message: `a ${run.module} run reports only ${run.module}'s Rules`,
        });
      }
    });
  })
  .register(contractsRegistry, {
    id: "SpotRun",
    description: "A run outside the Baseline: it can open Findings but never marks one Fixed.",
  });
export type SpotRun = z.infer<typeof SpotRun>;
