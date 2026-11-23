# Warden

Warden is a security and compliance suite for teams that build software with AI coding agents. It has three
modules: Guard, Patch and Vouch.

## Modules

**Warden**:
The whole suite, built as one product with one codebase.
_Avoid_: Keel, Defender, the platform

**Guard**:
The module that watches how software is made: AI coding agents, their configuration, their traces and the
dependencies they add.

**Patch**:
The module that watches what ships: products and their dependencies, matched against known vulnerabilities.

**Vouch**:
The module that proves compliance: policies, controls, gaps and evidence for an audit.

## Findings

**Team**:
The group that owns Assets and sees their Findings. Each Asset belongs to exactly one Team.
_Avoid_: org, organization, tenant, customer

**Scan**:
One run of a Baseline over some of a Team's Assets. A Scan marks a Finding Fixed only if it covered that Asset
with that Rule and didn't see the problem.
_Avoid_: check, audit

**Finding**:
One observed problem with one Asset, raised by one module. The same problem on three Assets is three Findings.
_Avoid_: alert, issue, result

**Verdict**:
Vouch's judgement of one Control: evidenced, partly evidenced, not evidenced or not applicable. A lead reviews it,
confirming it or overriding it with a reason.
_Avoid_: finding (for this)

**Gap**:
A Control whose reviewed Verdict is not evidenced or only partly evidenced. Findings flow up to Vouch as evidence, and
Vouch recomputes Gaps from them. A Gap has no Status of its own: risk is accepted on its Findings.
_Avoid_: missing control, Finding (for this)

**Asset**:
The thing a Finding is about. Its kind is one of Repo, Product, Device or Agent session.

**Repo**:
A source code repository, named by its URL.

**Dependency**:
A package that a Repo or Product uses. Not an Asset: a Finding about a Dependency belongs to the Repo or Product,
and names the package in its Fingerprint.
_Avoid_: library, package

**Product**:
Software a team ships, built from one or more Repos and linked to them by repo URL. Patch's vulnerability
Findings belong to the Product, not to one Repo.
_Avoid_: app, service

**Device**:
A developer's laptop, as reported by Guard's laptop script.

**Fingerprint**:
The Rule plus where the problem sits (a file path, a package, a CVE and package), without naming the Asset.
Findings with the same Fingerprint are the same problem on different Assets. Within one Asset, the same
Fingerprint in a later Scan is the same Finding.

**Severity**:
How bad a Finding is: Critical, High, Medium or Low. Patch maps CVSS bands onto it.
_Avoid_: Info, priority, risk score

**Status**:
Where a Finding stands: Open, Fixed, Accepted or False positive.

**Fixed**:
The next scan no longer sees the Finding. Set only by a rescan, never by hand.
_Avoid_: resolved, closed

**Accepted**:
A person has accepted the risk, with a reason and an expiry date. "Not affected" (the vulnerable part isn't used)
is one such reason. An agent may only propose it.
_Avoid_: ignored, waived, suppressed

**Unconfirmed fix**:
A Fixed Finding whose Scan also opened a new Finding with the same Rule on the same Asset, so the problem may only
have moved. A person confirms the fix, or marks it moved, which reopens it. Not a Status.
_Avoid_: suspect fix, moved (as a Status)

**False positive**:
A person has marked the Finding as wrong. An agent may only propose it. It feeds the eval.

**Rule**:
One check with an ID, such as `agent-can-read-env`. A Finding names the Rule that raised it.
_Avoid_: guard rule, check (as a noun)

**Pack**:
A named bundle of Rules, such as Default, Fintech or Games.
_Avoid_: baseline pack, industry pack

**Baseline**:
The set of Rules one team is held to. At Quick it's the Default Pack. At Audit-ready it's built from Vouch's
Policy.
_Avoid_: ruleset, policy (for this)

**Policy**:
A team's own written security rules, held in Vouch. A Policy shapes the Baseline at Audit-ready.

**Control**:
A requirement in a compliance standard (ISO 27001, TISAX). A Finding names one only once Vouch maps it.

**Agent session**:
One run of an AI coding agent. It's the Asset when the judge flags agent behaviour. Its trace is the evidence.
_Avoid_: trace (as the Asset)

## Levels

**Level**:
How much of Warden a team uses: Quick, Standard or Audit-ready. Each Level adds to the one before. A Team's
Level is read from what it has set up, never set by hand, and it unlocks nothing.
_Avoid_: mode, tier, plan

**Quick**:
The first Level: a repo scan against the default baseline, a top-5 fix list and one-click fix PRs. No decisions
needed up front.

**Standard**:
The second Level: adds the dashboard and the trace judge.

**Audit-ready**:
The third Level: adds a baseline taken from Vouch's policy, and sends evidence into Vouch.

**Privacy tier**:
How much of an agent session's content Guard may read and send to a model, from metadata only upwards.
_Avoid_: Level (for this)

## Testing

**Real-world run**:
A scan of real repos whose owners opted in, such as a cohort member's. Its Findings are seen only by that repo's
owner, and it isn't eval data.
_Avoid_: Seeded org (for this)

**Seeded org**:
A free GitHub org with public repos planted with known problems (fake but realistic secrets, risky agent
configuration). It holds the labelled cases the eval checks against.
_Avoid_: test org, demo org
