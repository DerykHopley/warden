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

**Role**:
What a person may do in one Team: Member, Lead or Admin. Each Role includes the one below it. Everyone in a Team
sees every page; a Role decides what they may change, and which page opens first.
_Avoid_: permission level, access level

**Member**:
A Role: sees everything, asks the chat, starts Spot runs and opens Fix PRs. Can only propose Accepted or False
positive.
_Avoid_: viewer, developer (as a Role)

**Lead**:
A Role: also makes the decisions a person must make: accepts risk, marks False positives, confirms or moves fixes,
reopens Findings, approves Proposals and reviews Verdicts.
_Avoid_: reviewer, compliance lead, approver

**Admin**:
A Role: also controls what Warden may collect and change: people and their Roles, the hook token, the GitHub write
grant, the Privacy tier, the Baseline, the Catalogues, retention, deleting data, and turning developer names on. A
Team always has at least one Admin.
_Avoid_: owner

**Assessor**:
A person outside the Team who may read its evidence for a limited time, such as a TISAX assessor. Not built yet.
_Avoid_: auditor (for this), guest

**Scan**:
One run of a Baseline over some of a Team's Assets. A Scan marks a Finding Fixed only if it covered that Asset
with that Rule and didn't see the problem. Patch's CVE refresh is a Scan (its Assets are Products). Scans are
reconciled in the order they started: where a newer Scan has already covered the same Asset and Rule, the older
Scan's result for that Asset and Rule is dropped. The rest of it still counts.
_Avoid_: check, audit

**Spot run**:
A run outside the Baseline, such as one Rule on demand, or the Judge over Agent sessions. It can open
Findings but never marks one Fixed.
_Avoid_: check run, ad-hoc scan

**Job**:
A run of Warden's work outside any request, as a Cloud Run Job execution. A Scan someone starts runs as one, and
so do the daily expiry job, the CVE refresh and the Judge's sweep. Each carries one Team, except the daily jobs,
which visit each Team in turn.
_Avoid_: background task, worker

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
The thing a Finding is about. Its kind is one of Repo, Product, Device or Agent session. A new kind needs an ADR.

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
The Rule plus where the problem sits (a file path, a package, a CVE and package), without naming the Asset or a
package's version, so an upgrade isn't a new problem.
Findings with the same Fingerprint are the same problem on different Assets. Within one Asset, the same
Fingerprint in a later Scan is the same Finding.

**Severity**:
How bad a Finding is: Critical, High, Medium or Low. Patch maps CVSS bands onto it. A change of Severity is
kept in the Finding's history.
_Avoid_: Info, priority, risk score

**Status**:
Where a Finding stands: Open, Fixed, Accepted or False positive. Every change names its Actor and reason.

**Actor**:
Who made a change: a person or an agent. An agent can't set Accepted or False positive; it makes a Proposal.

**Proposal**:
A decision an agent or a Member suggests: accepting a Finding, or marking it a False positive. It waits until a
Lead approves or rejects it, and keeps both who asked for it and who approved it.
_Avoid_: suggestion, draft decision

**Fix rate**:
Confirmed fixes in a period, divided by the Findings open at its start plus those opened during it. The dashboard
sets the period, e.g. 30 days. Unconfirmed fixes don't count.

**Fixed**:
The next scan no longer sees the Finding. Set only by a rescan, never by hand.
_Avoid_: resolved, closed

**Accepted**:
A person has accepted the risk, with a reason and an expiry date. "Not affected" (the vulnerable part isn't used)
is one such reason. An agent may only propose it. A daily job reopens every Accepted Finding whose expiry has
passed, whether or not a Scan sees it. An Accepted Finding a Scan sees again stays Accepted until its expiry. An
Accepted Finding a Scan no longer sees is Fixed.
_Avoid_: ignored, waived, suppressed

**Unconfirmed fix**:
A Fixed Finding whose Scan also opened a new Finding that may be the same problem moved. Each module says what
"may have moved" means: for Guard, the same Rule on the same Asset; for Patch, the same CVE under a different
package. A person confirms the fix, or marks it moved: the new Finding merges into the old one, which reopens
with its id, age and history and takes the new location. The Finding merged into the old one is closed as Fixed
and points to it with moved_to; it never counts in the Fix rate. Not a Status. Unconfirmed fixes don't count in
the Fix rate.
_Avoid_: suspect fix, moved (as a Status)

**False positive**:
A person has marked the Finding as wrong. An agent may only propose it. It feeds the eval. A person can reopen
it, with a reason. A False positive that a Scan no longer sees stays a False positive: only a person's reopen
changes it.

**Rule**:
One check with an ID that starts with its module, such as `guard/agent-can-read-env` or
`patch/known-vulnerability`. A Finding names the Rule that raised it.
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

**Catalogue**:
A published, versioned set of Controls, such as VDA ISA2027 or ISO 27001:2022. A Team chooses the Catalogues it's
assessed against. Verdicts and Gaps are per Catalogue.
_Avoid_: standard, framework (for this)

**Control**:
A requirement in one Catalogue, such as ISA2027 1.3.3. A Finding names one only once Vouch maps it. Controls in
different Catalogues, or different versions of one, aren't linked.

**Agent session**:
One run of an AI coding agent, made of Agent events. It's the Asset when the Judge flags agent behaviour; the
masked Agent events the Judge relied on are the evidence. It never changes, so its Findings are never Fixed: they
end as Accepted or False positive. Every session leaves a record, judged or not, after its events are dropped. It
names its Team and a pseudonymous developer, not a person, unless the Team turns names on.
_Avoid_: trace (as the Asset)

**Agent event**:
One thing an agent did in an Agent session, such as a prompt, a tool call or its result, as Warden receives it.
Kept only until the session is judged, and never longer than a few days.
_Avoid_: trace, span, log

**Judge**:
The model that reads an Agent session's events and flags behaviour against the Baseline. A Judge run is a Spot run.
_Avoid_: trace judge, LLM judge

## Levels

**Level**:
How much of Warden a team uses: Quick, Standard or Audit-ready. Each Level adds to the one before, and follows the
business's phase, from its first safeguards to its first audit. A Team's Level is read from what it has set up,
never set by hand, and it unlocks nothing.
_Avoid_: mode, tier, plan

**Quick**:
The first Level: a repo scan against the Default Pack and a top-5 fix list. No decisions up front. A Team that
grants write access gets one-click Fix PRs.

**Fix PR**:
A pull request Warden opens to fix a Finding. It needs the Team's write grant, and a person merges it.

**Standard**:
The second Level: adds the dashboard, the agent hook and the Judge.

**Audit-ready**:
The third Level: adds a baseline taken from Vouch's policy, and sends evidence into Vouch.

**Privacy tier**:
How much of an Agent session's content the hook sends to Warden: Metadata (tool names and outcomes), Details (adds
commands, file paths and URLs) or Content (adds tool output and prompts). Set per Team; Details by default. Warden
redacts what arrives, whatever the tier.
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
