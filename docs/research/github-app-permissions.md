# GitHub App permissions: the minimum, and what more could show

Researched 2026-11-26 for the owner's question on the read-only app (Guard #100), the write app (#224) and the manifest idea (#293). Sources: docs.github.com only. **Checked** = read on the linked page. **Unverified** = not found on the pages read.

Link keys: [P] = [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [C] = [Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## What Warden calls today (from the code)

| Call | Where | Auth | Permission it needs |
|---|---|---|---|
| `POST /app/installations/{id}/access_tokens` | `github-reader.ts`, `github.ts` | app JWT | none; it mints the token ([apps](https://docs.github.com/en/rest/apps/apps)) |
| `GET /app` | `github.ts` (app slug) | app JWT | none (unverified: not in [P]) |
| `POST github.com/login/oauth/access_token` | `github.ts` (link check) | OAuth code | not a REST permission |
| `GET /user/installations` | `github.ts` | user token | not found in [P] (unverified) |
| `GET /user/installations/{id}/repositories` | `github.ts` | user token | Metadata read [P] (checked) |
| `GET /repos/{o}/{r}/tarball` | `github-reader.ts` (Scan) | installation token | Contents read [P] (checked) |
| `GET /repos/{o}/{r}/commits?per_page=1` | `github-reader.ts` (empty repo) | installation token | Contents read [P] (checked) |

- The Scan's token is already scoped down: one repo, `permissions: { contents: "read" }`. GitHub lets a token ask for less than the app holds, never more ([apps](https://docs.github.com/en/rest/apps/apps), checked). So any permission added below reaches a call only if that call's token asks for it too.
- No Fix PR code exists yet (#224 is open). The write app's calls below are the ones #224 describes.

## Tier 0: the minimum

### Read-only app (Guard Scans)

| Permission | Why | Source |
|---|---|---|
| Contents: read | tarball and commits | [P] (checked) |
| Metadata: read | the user-token repo list; required whenever any repository permission is chosen | [P] (checked for the endpoint) |

- **Metadata is effectively mandatory.** The docs say an app gets Metadata read by default, and GitHub sets it back to read-only if you pick "No access" while any repository permission is chosen. Source: the [P] page, as GitHub's own search summary quotes it. **Unverified:** I could not find this wording on the current [P] or [C] page text. The [installation token](https://docs.github.com/en/rest/apps/apps) page does list `metadata` as a token permission (checked).
- Nothing else is needed. This matches #100's decision (checked against the code above).

### Write app (Fix PRs, #224)

| Permission | Calls | Source |
|---|---|---|
| Contents: read and write | `POST git/refs` (the branch), `POST git/blobs`, `git/trees`, `git/commits`, or `PUT contents/{path}` (the edit) | [P] (checked: all Contents write) |
| Pull requests: read and write | `GET pulls` (find one already open) needs read; `POST pulls` (open it) needs write | [P] (checked) |
| Metadata: read | required, as above | as above |

- **Contents write is needed to push the branch.** `POST /repos/{o}/{r}/git/refs` is Contents write [P] (checked).
- **Pull requests write is needed to open the PR.** `POST /repos/{o}/{r}/pulls` is Pull requests write [P] (checked).
- **Workflows is not needed while no edit touches `.github/workflows/`.** [C] says an app that must "access or edit Actions files in the `.github/workflows` directory" should request Workflows (checked). [P] lists `PUT contents`, `POST/PATCH git/refs` under Workflows write as an *additional* permission (checked). #224's server refuses any edit there, so the app can skip it. **Unverified:** whether a branch whose new commit changes no workflow file ever needs Workflows. The docs don't say it outright; GitHub's behaviour is that it only applies when workflow files change.

## Optional permissions that would add visibility

All read-only. Warden needs **read** for every one; none needs write. "Module" uses the glossary: Guard (how software is made), Patch (what ships, known vulnerabilities), Vouch (controls and evidence).

| Permission (read) | Key endpoints [P] | What Warden could do | Module / Finding | Data it exposes to Warden |
|---|---|---|---|---|
| **Metadata (already held)** | `GET rulesets`, `GET rules/branches/{branch}`, `GET properties/values` | Check the default branch has rules (PR required, no force push) | Guard Rule "default branch unprotected"; Vouch evidence | Rulesets and their rules. `bypass_actors` only returns to callers with write on the ruleset ([rules](https://docs.github.com/en/rest/repos/rules), checked) |
| Administration | `GET branches/{b}/protection`, `GET rulesets/rule-suites` | Classic branch protection (older repos use it, not rulesets) | Guard Rule; Vouch evidence | Protection settings, plus far more: [C] says explain Administration on your homepage (checked). Broadest read here |
| Dependabot alerts | `GET dependabot/alerts` | Import open vulnerable dependencies | Patch: a Finding per alert (package, GHSA, CVE, severity, first patched version) ([alerts](https://docs.github.com/en/rest/dependabot/alerts), checked) | Vulnerable packages and paths |
| Code scanning alerts | `GET code-scanning/alerts` | Import CodeQL and other tool alerts | Patch or Guard; Vouch "code is scanned" evidence | Rule, tool, file path and lines ([code scanning](https://docs.github.com/en/rest/code-scanning/code-scanning), checked). 403 without Advanced Security |
| Secret scanning alerts | `GET secret-scanning/alerts` | Leaked-secret Findings | Guard | **The raw secret by default.** Always pass `hide_secret=true` ([secret scanning](https://docs.github.com/en/rest/secret-scanning/secret-scanning), checked) |
| Repository security advisories | `GET security-advisories` | The repo's own published advisories | Patch; Vouch (vulnerability disclosure) | Advisory text |
| Checks | `GET commits/{ref}/check-runs`, `check-suites` | See whether CI ran and passed on a commit | Vouch evidence ("changes are tested"); Guard (agent PRs merged red) | Check names and results |
| Commit statuses | `GET commits/{ref}/status(es)` | The same, for older CI that posts statuses | as Checks | Status contexts |
| Actions | `GET actions/workflows`, `actions/runs`, `runs/{id}/jobs`; also `GET environments` | Workflow inventory and run history | Guard (agent workflows, e.g. Claude Code Action); Vouch | Run and job metadata |
| Environments | `GET environments/{env}/secrets`, `variables` | Deployment environment inventory | Vouch (separation of environments) | Secret names; variable values (unverified that values return) |
| Secrets | `GET actions/secrets`, `actions/organization-secrets` | Secret inventory: stale or unused secrets | Guard; Vouch | **Names and dates only**, "without revealing their encrypted values" ([secrets](https://docs.github.com/en/rest/actions/secrets), checked) |
| Webhooks | `GET hooks`, `hooks/{id}/deliveries` | Where repo events are sent | Guard (data leaving the repo) | Hook URLs and delivery logs |
| Issues | `GET issues` | Link Findings to tracked work | Vouch (a gap is tracked) | Issue titles and bodies: high content, low value now |
| Org: Members | `GET orgs/{org}/members`, `teams` | Who has access; match to Warden's people | Vouch (access review) | Member logins, teams |
| Org: Custom properties | `GET orgs/{org}/properties/schema`, `values` | Read a repo's tags (e.g. `production`) | Guard / Patch priority | Property values |
| Org: Administration | `GET orgs/{org}/actions/permissions`, `code-security/configurations` | Org-wide Actions and security settings | Vouch | Org settings |

- **Audit log:** `GET /orgs/{org}/audit-log` needs an organization owner ([orgs, Enterprise Cloud docs](https://docs.github.com/en/enterprise-cloud@latest/rest/orgs/orgs#get-the-audit-log-for-an-organization), checked). **Unverified:** which GitHub App permission, and whether it works outside Enterprise Cloud.
- **Webhook events** (the app's own `hook_attributes`) are not the Webhooks permission. They stay off: the "Active" box can be cleared ([registering](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), checked).

## Recommended opt-in order

| Tier | Adds | For | Why here |
|---|---|---|---|
| 0 | Contents read, Metadata read | everyone | today's Scan; ruleset Rules need nothing more |
| 1 | Dependabot alerts, Checks, Commit statuses, Secrets (names only), Repository security advisories | most Teams | metadata-like, no file content beyond Tier 0, feeds Patch and Vouch at once |
| 2 | Code scanning alerts, Secret scanning alerts (`hide_secret=true`), Actions, Environments, Webhooks | Teams wanting full Guard | more sensitive: code locations, secrets, infra URLs |
| 3 | Administration, Org: Members, Org: Administration, Org: Custom properties | Vouch audits | broadest reach, org-level; [C] asks for an explanation |
| W | Write app: Contents write, Pull requests write | Teams that opt in to Fix PRs | already separate (#224) |
| — | Issues, Workflows, any write beyond W | not offered | low value, or widens what an agent could change |

- **Do one app per tier, or one app that grows?** Adding permissions to an installed app prompts "the owner of each account where the app was installed" to approve; until then "their installation will continue to use the old permissions" ([C], checked; [approving](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app), checked). So growing one app works, but every Team re-approves at each step, and Warden must handle an installation that still holds the old set (the link check in `installationPermissions` refuses anything not read-only today).
- **Cautious users:** keep Tier 0 as the default and the how-to (#224) as the path. Each tier is a visible, named grant they choose.
- **Users happy to let it run (#293):** the manifest's `default_permissions` sets the tier at registration ([manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), checked). The conversion returns `client_id`, `client_secret`, `webhook_secret` and `pem` ([apps](https://docs.github.com/en/rest/apps/apps), checked), and the code must be exchanged within one hour. That makes #293 a secrets decision, as the issue says.
- **Repo selection:** installers choose "All repositories" or "Only select repositories" ([installing](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party), checked). Suggest "Only select" to cautious users in the how-to.

## Sources

- https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app
- https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
- https://docs.github.com/en/rest/apps/apps
- https://docs.github.com/en/rest/apps/installations
- https://docs.github.com/en/rest/repos/rules
- https://docs.github.com/en/rest/dependabot/alerts
- https://docs.github.com/en/rest/code-scanning/code-scanning
- https://docs.github.com/en/rest/secret-scanning/secret-scanning
- https://docs.github.com/en/rest/actions/secrets
- https://docs.github.com/en/enterprise-cloud@latest/rest/orgs/orgs#get-the-audit-log-for-an-organization
