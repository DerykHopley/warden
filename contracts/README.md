# @warden/contracts

The contracts Warden's parts share: the API bodies the server sends and the dashboard reads, **Finding v1**, and
what a module hands over when it reports what it saw. Each is a zod schema with its inferred type of the same name.
ADR 0005 is binding; GLOSSARY.md defines the words.

Everything below is a contract, not only code: a second implementation (the Rust desktop app, ADR 0004) rebuilds
the Fingerprint and the events hash from this page, reads the JSON Schema files, and runs the reconcile cases.

## Entry points

- `@warden/contracts`: the schemas, `fingerprint()` and `agentEventsHash()`. The dashboard bundles it, so it holds
  no file-system code.
- `@warden/contracts/reconcile-cases`: Node only. `loadReconcileCases()` returns every case in `reconcile-cases/`,
  parsed and checked; `loadReconcileCase(file)` loads one. A bad file fails with an error naming it.

## Finding v1

`Finding` is one observed problem with one Asset, raised by one module. Fields are snake_case.

- **Identity:** `id`, `team`, `asset` (`{ kind, ref }`, `kind` one of `repo`, `product`, `device`,
  `agent_session`), `module` (`guard`, `patch`, `vouch`), `rule_id` (starts with the Finding's own module and a
  slash), `fingerprint` (below), `location`.
- **Judgement:** `severity` (`critical`, `high`, `medium`, `low`), `title`, `evidence`, optional `control`
  (`{ catalogue, ref }`, set only once Vouch maps it).
- **Lifecycle:** `status` (`open`, `fixed`, `accepted`, `false_positive`), `unconfirmed_fix` (null, or
  `{ candidates }`: ids of new Findings that may be this one moved; only on a Fixed Finding), `accepted_reason` and
  `accepted_until` (set exactly when the status is `accepted`), `first_seen_scan` and `last_seen_scan` (the id of a
  Scan or Spot run), `moved_to` (null, or the id of another Finding this one was merged into; this one is then
  `fixed`).

A `Location` is one of:

| `kind`       | Fields                                                    | Goes with                       |
| ------------ | --------------------------------------------------------- | ------------------------------- |
| `file`       | `path`, optional `line`                                   | a Repo or Product               |
| `dependency` | `package`, `version`, optional `vulnerability` (a CVE id) | a Repo or Product               |
| `setting`    | `name`                                                    | a Device                        |
| `session`    | none                                                      | an Agent session, and only that |

A `path` is relative to its Asset and has one spelling, so one file has one Fingerprint: parts joined by `/`, none
of them empty, `.` or `..`, no `\`, and no drive letter followed by `/` (`C:/…`). So `/etc`, `../x`, `./x`,
`a/./b`, `a//b`, `a/` and `a\b` are all refused. A `session` Location goes only with an `agent_session` Asset, and
an `agent_session` Asset only with a `session` Location. A parsed Finding is read-only all the way down: it and
every object and array in it are frozen, and its type is readonly.

## The Fingerprint rule

`fingerprint(rule_id, location)`: the Rule id, then where the problem sits, joined with `|`.

| Location     | Fingerprint                                                     |
| ------------ | --------------------------------------------------------------- |
| `file`       | `<rule_id>\|file:<path>`                                        |
| `dependency` | `<rule_id>\|dependency:<package>\|<vulnerability>` (empty when none) |
| `setting`    | `<rule_id>\|setting:<name>`                                     |
| `session`    | `<rule_id>\|session`                                            |

- A file's `line` is left out, so a problem that moves lines in the same file is the same Finding.
- A package's `version` is left out, so an upgrade isn't a new problem.
- The Asset is never part of it, so the same problem on two Assets has the same Fingerprint.
- No part holds a `|`: a Rule id (which also holds no whitespace), a `package`, a `vulnerability` and a setting's
  `name` with one are refused, so a Fingerprint splits back into its parts one way.
- A `path` has one spelling (above), so the same file can't give two Fingerprints.
- `Finding` refuses a `fingerprint` that isn't the one this rule gives.

## Evidence

`Evidence` is `summary` (at most 2,000 characters), optional `secret`, optional `session`, and no other key.
**Evidence never holds a secret's value or an Agent event's raw content**: there is no field for either, and every
object is strict, so an extra key is refused rather than dropped.

- **`secret`:** `{ type, path, line, mask }`. A `mask` shows at most 4 characters of the value and hides the rest
  with `*` (`AKIA****************`); a mask showing more, or with no `*`, is refused.
- **`session`** (required on an Agent session Finding, refused on any other): what a Judge's Finding keeps after
  the session's events are dropped (ADR 0007, `docs/data.md`, threat J8).
  - `events`: 1 to 50 `MaskedAgentEvent` values the Judge relied on, in session order (`seq` strictly increasing).
  - `events_read`: how many redacted events the Judge read; at least the number kept, and above every kept `seq`.
  - `events_hash`: `agentEventsHash()` of every redacted event the Judge read, in order.
- **`MaskedAgentEvent`:** `{ seq, at, name, tool?, text }` and nothing else. `seq` is the event's 0-based position
  among the events the Judge read; `name` the hook event name (1 to 64 characters); `tool` 1 to 128 characters;
  `text` the redacted content at the Team's Privacy tier, at most 4,000 characters, empty allowed.

## The events hash: `agentEventsHash()`

`agentEventsHash(events)` returns `sha256:` and the lower-case hex SHA-256 of the events' canonical form:

1. Each event as compact JSON (no spaces) with its keys in the order `seq`, `at`, `name`, `tool`, `text`; `tool`
   is left out when absent. Strings are escaped as JavaScript's `JSON.stringify` escapes them.
2. The events in the order given, joined with `\n` (no newline after the last).
3. Encoded as UTF-8, hashed with SHA-256.

It parses its input with `MaskedAgentEvent` first, so it refuses a raw event or an empty list. The hash is over
redacted text only, so a short secret can't be confirmed by guessing it and hashing. It uses Web Crypto, so it is
async and works in the browser.

### Worked example

These events:

```json
[
  { "seq": 0, "at": "2026-11-24T09:15:02Z", "name": "UserPromptSubmit", "text": "Fix the failing login test" },
  { "seq": 1, "at": "2026-11-24T09:15:09Z", "name": "PreToolUse", "tool": "Bash", "text": "cat .env" },
  {
    "seq": 2,
    "at": "2026-11-24T09:15:10Z",
    "name": "PostToolUse",
    "tool": "Bash",
    "text": "AWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret_key]"
  }
]
```

have this canonical form (three lines):

```text
{"seq":0,"at":"2026-11-24T09:15:02Z","name":"UserPromptSubmit","text":"Fix the failing login test"}
{"seq":1,"at":"2026-11-24T09:15:09Z","name":"PreToolUse","tool":"Bash","text":"cat .env"}
{"seq":2,"at":"2026-11-24T09:15:10Z","name":"PostToolUse","tool":"Bash","text":"AWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret_key]"}
```

and this hash: `sha256:d1f73bcf2237652bc8ecd03f47b681e3b6f872c4c0d46c14f27019939de8ae7d`

A unit test checks this example against `agentEventsHash()`.

## What a module hands over

- **`Observation`:** one thing a run saw: `asset`, `rule_id`, `location`, `severity`, `title`, `evidence`, with the
  same Asset, Location and Evidence rules as a Finding. Strict: an Observation carrying a `status`, `fingerprint`,
  `id`, `first_seen_scan` or any other key is refused, so a module can't write a Status, a Fingerprint or history.
- **`Scan`:** what `reconcile(scan)` takes: `id`, `team`, `module`, `started_at`, `assets` and `rules` (what it
  covered), `observations`. Each Observation's Asset and Rule must be among those it covered; every Rule is the
  Scan's module's. A Scan may not cover an `agent_session` Asset: an Agent session is never rescanned.
- **`SpotRun`:** what `report(...)` takes: `id`, `team`, `module`, `started_at`, `observations`, and no `assets` or
  `rules`, since a Spot run covers nothing and never marks a Finding Fixed. Its Observations may be on any Asset.

## The reconcile cases

`reconcile-cases/` holds one JSON file per case, each valid against `ReconcileCase`. Any implementation of
reconcile runs them: apply `given`, then each step in order, then compare the Team's Findings with `expect`.

```jsonc
{
  "name": "A Fixed Finding that a Scan sees again reopens",   // unique across the folder
  "rule": "…",                                              // the glossary or ADR 0005 sentence it checks, quoted
  "given": { "now": "2026-11-24T08:00:00Z", "findings": [ /* full Finding values */ ] },
  "steps": [ /* applied in order, below */ ],
  "expect": [ /* every Finding the Team has after the steps */ ]
}
```

**Steps**, each an object with a `step` field:

- `{ "step": "scan", "scan": <Scan>, "labels": { "<label>": <index> } }`: reconcile one Scan. `labels` (optional)
  names the new Finding that the Observation at that index opens, so later steps and `expect` can refer to it; the
  implementation chooses new ids. A labelled Observation that opens no new Finding fails the case.
- `{ "step": "spot_run", "spot_run": <SpotRun>, "labels": { … } }`: report one Spot run.
- `{ "step": "decision", "decision": "<name>", "finding": <ref>, "actor": { "kind": "person", "id": "…" },
  "reason": "…" }`: a person's named decision, one of `accept` (also `until`, a date-time), `mark_false_positive`,
  `confirm_fix`, `mark_moved` (also `candidate`, a ref to the new Finding merged in) or `reopen`. An `agent` Actor
  is refused: agents only propose.
- `{ "step": "expire", "now": "<date-time>" }`: the daily job that reopens Accepted Findings whose expiry has passed.

**Refs** name a Finding: `{ "id": "f-1" }` for one in `given`, `{ "new": "<label>" }` for one a step created. A
step may refer only to a label an earlier step created; an unknown id or label fails the case.

**`expect`** lists every Finding the Team has after the steps, each named by a ref (`id` or `new`) plus only the
fields the case checks. A field that holds a Finding id there (`moved_to`, `unconfirmed_fix.candidates`) holds a ref
instead, since new Findings' ids aren't known in advance. A Finding not listed must not exist. The Finding rules
hold among the fields an expectation gives (a Rule of its module, the Location and Asset pairing, the Fingerprint,
the lifecycle fields against `status`); a rule whose fields are left out isn't checked.

A label names one new Finding, so a step gives each Observation at most one label, and a `mark_moved` never names
the same Finding as both `finding` and `candidate`.

## JSON Schema

`json-schema/` holds one JSON Schema (draft 2020-12) per published schema: `Finding`, `Observation`, `Scan`,
`SpotRun` and `ReconcileCase`, written by zod's `z.toJSONSchema` and formatted with prettier. They're committed so
code outside Node can read them. They carry the shapes (fields, types, bounds, strictness) and every rule on a
single string as a `pattern`, the mask and path rules included; none uses lookaround, so Rust's `regex` crate runs
them as written. The rules between fields (the Location and Asset pairing, the lifecycle fields, a Scan's
coverage, the Fingerprint) are enforced by the zod schemas and stated on this page.

After changing a schema, regenerate them:

```sh
pnpm --filter @warden/contracts json-schema
```

A contracts test fails when a committed file differs from what the script would write now.
