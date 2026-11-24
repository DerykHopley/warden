# One reconcile step for all Findings

Every module hands what it saw to one reconcile step in the Findings module, and only that step decides a
Finding's lifecycle: opened, still open, Fixed, reopened, or flagged as an Unconfirmed fix. A module never writes
a Status. People change a Status only through named decisions, and agents only through Proposals.

## The interface

- **Modules write with a scoped scan.** `findings.scan({ team, module, assets, rules }, async (scan) => { scan.saw(...) })`.
  The Assets and Rules passed in are what the Scan covered; `saw` refuses anything outside them; if the callback
  throws, nothing is written. A scanner never mentions Status, Fingerprint or history.
- **Underneath, a Scan is a plain value.** `reconcile(scan) → outcome`: one Scan in, one result out, and a retried
  Scan changes nothing. A background job can queue a Scan and hand it over whole.
- **Spot runs use `report(...)`.** A Spot run (one Rule on demand, or the trace judge over Agent sessions) opens or
  updates Findings and never marks one Fixed. An Agent session never changes, so its Findings are never Fixed:
  they leave Open only as Accepted or False positive.
- **Each module gives its "may have moved" rule.** Guard: same Rule on the same Asset. Patch: same CVE under a
  different package or version.
- **People decide through named calls** (accept, mark false positive, confirm fix, mark moved, reopen), each
  needing an Actor who is a person.
- **The Finding format is a shared zod schema** (ADR 0004) and Findings come back read-only.

## Dependency direction

Guard, Patch and Vouch import `findings` and `scans`; those never import a module. There is no scanner registry:
the server's start-up file wires each module's scanners to the job scheduler, and each module's chat tools to
the agent. An eslint import rule fails a build where shared code imports a module. Adding a module touches no
shared code.

## Contracts stay language-neutral

The local-first desktop app is Rust (ADR 0004). So the reconcile cases are data files any implementation runs, not
only TypeScript tests, and the Finding schema is also published as JSON Schema.

## Why this shape

Three designs were built as throwaway spikes against 16 shared cases from the glossary (2026-11-24): a minimal
`reconcile(Scan)`, a flexible event protocol with the lifecycle as a transition table, and the scoped scan. All
passed every case. This ADR combines the scoped scan (the call written most often, in every port), the Scan as a
value (what a background job needs), and the event design's per-module move rule (the only one that fixed Patch's
Unconfirmed-fix misfire). The event protocol and registry were left out: nothing streams yet, and they cost a
wider interface and about 40% more code. The design was then ported to TypeScript (28/28 tests).

Spike code, cases and comparison: the capstone archive, `architecture/spikes/reconcile/` and
`architecture/spikes/stack-ts/reconcile/`.

## Consequences

- Building the three spikes found thirteen gaps in the glossary; the decisions are in GLOSSARY.md (Unconfirmed
  fix, Accepted, Rule, Fingerprint, Scan, Spot run, Actor, Proposal, Fix rate).
- Asset identity uses a string key (`kind:ref`) inside the Findings module: TypeScript has no value equality.
- A crash inside a scan callback discards that whole Scan. Large runs split into several Scans.
- A daily job reopens expired acceptances, since Agent sessions are never rescanned.
- **Scan order is per Asset and Rule:** a late Scan's results are dropped only for the Assets and Rules a newer
  applied Scan already covered; the rest of it applies. Two Scans on different Repos never block each other.
