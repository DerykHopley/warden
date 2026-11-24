# Warden's data

What Warden stores, whose it is, where it lives, how long it's kept, how it's deleted, and what leaves the
machine. It's written for someone who will run Warden, or trust it with their Team's data. The threats against
this data, and how each is met, are in [`threat-model.md`](threat-model.md).

**Built or designed.** Every row says which. **Built** means the code exists and has a test, with the slice or
spec that built it. **Designed** means it's decided but not built yet, with the spec that will build it. A
designed row is a plan, not a guarantee. Slices are the foundation spec's (#1): slice 1a is #4, slice 2 is this
document. The Guard, Patch and Vouch specs come after the foundation.

Where this document and an ADR disagree, the ADR wins.

## The inventory

| Store | What it holds | Whose | Where | How long | How it's deleted | Built or designed |
|---|---|---|---|---|---|---|
| Cloud SQL: Teams | One row per Team: its Clerk Organization id, its settings (Privacy tier, names on or off, the GitHub write grant, spending limits) | Team | Cloud SQL Postgres, europe-west1 | Life of the Team | Deleting the Team removes the row at once | Built in part: the table, its id and when it was made (slice 4b, #12); the row written on the Team's first visit to Warden by its Clerk `org:admin` (slice 5a, #27). Designed: the settings |
| Cloud SQL: Roles and Role history | Each person's Role in a Team, keyed by Clerk user id, and an append-only history of every Role change (who gave whom which Role, when). No names or emails: the dashboard reads those from Clerk when it shows them | Team; the person's Clerk user id | Cloud SQL Postgres, europe-west1 | Roles: while the person is in the Team. Role history: life of the Team (audit evidence, ISA2027 4.2.1). A person who leaves stays in history by Clerk user id only; once Clerk deletes them, history shows "former member" | A Role row goes when the person leaves the Team. History can't be edited or deleted by the app; deleting the Team removes it at once | Built in part (slice 5a, #27): `team_members` (Team, Clerk user id, Role, when they joined) and the append-only `role_history` (whose Role went from what to what, the kind of change, who made it, when), written on a person's first visit to Warden: the Team's Clerk `org:admin` creates it as Admin, anyone else joins as Member. A trigger refuses every update, delete and truncate of history. Changing a Role (slice 5b, #30): an Admin gives a person a Role through the API, which updates their row and appends a `changed` history row naming the Admin; a Team always keeps one Admin. Designed: removing a Role row when the person leaves (#29); Team deletion, which needs a marked way past the trigger |
| Cloud SQL: Scans | What each Scan covered (module, Assets, Rules) and when it ran | Team | Cloud SQL Postgres, europe-west1 | Life of the Team | Deleting the Team removes them at once | Built: every Scan and Spot run reconciled (id, module, when it started, when it was applied) and the Asset and Rule pairs each Scan covered, which recognise a retried Scan and decide scan order (slice 7, #22). Team deletion isn't built yet |
| Cloud SQL: Findings and their Status history | Findings in the Finding v1 format, with masked evidence (path, line, type and a mask, never a secret's value). An Agent session's Finding keeps the masked Agent events the Judge used and a SHA-256 hash of the redacted events it read. The append-only Status history names each change's Actor and reason, and keeps Severity changes | Team; the deciding person's Clerk user id | Cloud SQL Postgres, europe-west1 | Life of the Team (audit evidence, ISA2027 5.2.4) | History can't be edited or deleted by the app; deleting the Team removes Findings and history at once | Built: the format (slice 6, #11); the `findings` table, reconcile, and the append-only Status history with the Scan or Spot run behind each change, its reason, and Severity changes (slice 7, #22); a Lead's named decisions (accept, False positive, confirm a fix, mark one moved, reopen), each a history row naming the person by Clerk user id, with their reason (slice 8a, #35); a history row names the Proposal a decision approved, and the daily Job reopens an Accepted Finding whose expiry has passed, as a history row naming the Job (`job`, `daily-expiry`) (slice 8b, #36). Designed: Team deletion, which needs a marked way past the append-only trigger (not yet planned). The Guard, Patch and Vouch specs write them |
| Cloud SQL: Proposals | Decisions (accept, or mark a False positive) that a Member, a Lead or an agent suggests, with the reason and an accept's expiry; who asked (a Clerk user id or an agent's id) and when; and who decided (a Lead's Clerk user id), when, and a rejection's reason | Team; the asking and deciding people's Clerk user ids | Cloud SQL Postgres, europe-west1 | Life of the Team | Decided once, then kept: a trigger refuses any edit to a decided Proposal and any delete, by the app or the tables' owner; deleting the Team removes them at once, and needs the same marked way past the trigger as history | Built: slice 8b (#36). Who asks: a Member, a Lead or an agent. Who decides: a Lead |
| Cloud SQL: Agent events | What the hook sends, at the Team's Privacy tier, redacted on arrival before it's stored | Team; the developer, by pseudonym | Cloud SQL Postgres, europe-west1 | Until the Agent session is judged, and at most 7 days. An Agent event lasts at most 15 days in any form: up to 7 days live, up to 1 more until the daily delete job runs, then up to 7 in backups (recovery logs keep 6) | A daily job deletes every Agent event that is judged or older than 7 days. Deleting the Team removes them at once | Designed: Guard spec |
| Cloud SQL: Agent session records | One record per Agent session, without content: Team, pseudonymous developer, agent, start and end times, judged or not, outcome | Team; the developer, by pseudonym | Cloud SQL Postgres, europe-west1 | Life of the Team (evidence that logs are checked, ISA2027 5.2.4) | Deleting the Team removes them at once | Designed: Guard spec |
| Cloud SQL: Real-world run Findings | Findings from scans of real repos whose owners opted in, such as a cohort member's. Never eval data | The repo's owner | Cloud SQL Postgres, europe-west1 | Life of the Team that holds them, which only the repo's owner belongs to | The repo's owner deletes that Team, and the rows go at once | Designed: Guard spec |
| Cloud SQL: embeddings | Vectors (pgvector) of text Warden searches, such as CVE text or a Team's Policy | Team, or Warden for public text | Cloud SQL Postgres, europe-west1 | As long as the text they come from | Deleted with the text they come from; deleting the Team removes the Team's at once | Designed: Patch and Vouch specs |
| Cloud SQL: agent checkpoints | The chat agent's saved conversation state, under thread ids that carry the Team (ADR 0006) | Team; the person chatting | Cloud SQL Postgres, europe-west1 | Decided by the spec that builds the chat agent (an open question below) | Deleting the Team removes them at once | Designed: the chat agent spec (not yet planned) |
| Cloud SQL automated backups | Daily copies of the whole live database, including any Agent events it held that day | Every Team, and Warden | Cloud SQL, in Warden's GCP project | 7 automated backups, one a day from 03:00 UTC, so the oldest is at most 7 days old (`--retained-backups-count=7`, `--backup-start-time=03:00`). No on-demand backup of live data is kept longer than 7 days. The setup script doesn't set a final backup: if the instance is ever deleted with one, its retention is chosen when the instance is deleted, and Warden's operator chooses 7 days there (Cloud SQL's default is 30) | Cloud SQL prunes the oldest automated backup each day. A deleted Team's rows age out of the backups within 7 days | Built: slice 1b-ii, the setup script (#16). What it shows live is #24's to record |
| Cloud SQL point-in-time recovery logs | The database's transaction logs, which can rebuild it at any moment in the recovery window | Every Team, and Warden | Cloud SQL, in Warden's GCP project (on the instance's disk or in Cloud Storage, as Cloud SQL stores them) | Point-in-time recovery on, logs kept 6 days (`--retained-transaction-log-days=6`), because Cloud SQL requires fewer log days than retained backups, and Warden keeps 7 backups | Cloud SQL drops logs older than the setting. A deleted Team's rows age out of them within 6 days, and out of backups within 7 | Built: slice 1b-ii, the setup script (#16). What it shows live is #24's to record |
| The shared owner-preview database | Seeded data only, plus the owner's own test sign-ins. Never real Agent events and never a Real-world run's data: no hook is ever pointed at a preview revision | Warden (fake data) | Cloud SQL, europe-west1: the database `warden_preview`, on the same instance as the live database but apart from it | Until the next reseed | Reseeded or dropped at any time; nothing in it needs keeping | Built in part: the database `warden_preview` exists on the same instance (slice 1b-ii, the setup script, #16). It has its own roles (`warden_preview_migrate`, `warden_preview_app`, `warden_preview_admin`) with their own passwords, and only they may connect to it: no live role can, and no preview role can connect to `warden` (#32). Preview revisions reach it only as `warden-preview-run`, which reads no live password (#32). Deploying them there: #24 |
| Cloud Run instances | A repo's working copy during a Scan, and Agent events in flight before they're stored. Cloud Run's file system is in memory | Team | Cloud Run, europe-west1 | For one request or one Scan | Deleted when the Scan ends, and gone when the instance stops | Designed: Guard spec |
| Cloud Storage | Large files (ADR 0002), such as a Team's Policy documents or evidence uploads | Team | Cloud Storage, europe-west1 | Life of the Team | Deleting the Team deletes its objects at once | Designed: Vouch spec |
| Secret Manager | Today nine secrets. Made by hand: `warden-db-password` (Cloud SQL's `postgres`), `warden-clerk-secret`, `warden-clerk-publishable` and `warden-clerk-jwt-key`. Generated by the setup script: `warden-db-app-password` and `warden-db-migrate-password` (warden_app's and warden_migrate's passwords), `warden-db-admin-password` (warden_admin's, read only by `warden-daily`, the daily Job's account), and `warden-db-preview-app-password` and `warden-db-preview-migrate-password` (warden_preview_app's and warden_preview_migrate's). No service account reads `warden-db-password`: only the setup script's roles step reads it, on the owner's machine, into the one roles process's environment. Later the hook token per Team, the GitHub app's private key and webhook secret, the OpenRouter key, the Langfuse keys, and the pseudonym key per Team | Warden; a Team's own hook token and pseudonym key | Secret Manager, Warden's GCP project. The script's five are user-managed, in europe-west1 only; the four made by hand are replicated only as the owner made them. The script prints all nine's replication, and #24 records what they showed | While in use. A rotated hook token stays valid 24 hours, then its version is disabled; a replaced secret's old version is destroyed | An Admin rotates the Team's hook token; deleting a Team destroys its hook token and pseudonym key | Built: slice 1b-ii, the setup script (#16, #32): the four generated passwords, and which service account may read each secret (threat model, TB4); slice 8b (#36): the admin password and `warden-daily`. Designed: Guard spec (hook tokens, GitHub app, OpenRouter, Langfuse, pseudonym keys) |
| Cloud Logging | Warden's own log lines (one JSON object per line, through the redactor), Cloud Run's request logs (method, path, status, latency, the caller's IP and user agent), and Secret Manager's Data Access logs: which principal read which secret, and when, never the value. Never an Agent event's content, a hook token, a secret value or a session token | Warden; people's IP addresses | Cloud Logging, Warden's GCP project, `_Default` bucket | 30 days (`--retention-days=30` on the `_Default` bucket; configurable from 1 to 3650 days). Google's Admin Activity audit logs go to the `_Required` bucket, 400 days, not configurable; they hold who changed the cloud setup, not Team data | Logs age out; no entry is deleted by hand | Built: slice 1a (#4: redactor and logger); slice 1b-ii, the setup script (#16): the `_Default` bucket set to 30 days, and Secret Manager's Data Access logs turned on. What it shows live is #24's to record |
| Clerk | Each person's identity (name, email, sign-in sessions), the Clerk Organization for each Team, membership, and `org:admin` for Warden Admins | The person; the Team | Clerk, United States (Clerk offers no region choice) | Until the person deletes their account, or is removed, or the Clerk Organization is deleted | Through Clerk: the person deletes their account, or an Admin removes them; deleting a Team deletes its Clerk Organization | Built: slice 1a (#4: sign-in); the Admin sync (slice 5b, #30: when an Admin makes someone Admin, takes Admin away, or sets someone's current Role again, Warden sets their Clerk role to `org:admin` or `org:member` through Clerk's Backend API; someone Clerk calls `org:admin` who joins a Team as a Member is set to `org:member`). Designed: the Organization switcher in the dashboard (slice 10) |
| OpenRouter and the model providers behind it | The redacted Agent events and repo text the Judge reads, for one call | Team | OpenRouter, and the provider that serves the call | Not kept: OpenRouter keeps no prompt or response unless an account opts in, and Warden doesn't; Warden routes only to Zero Data Retention endpoints. OpenRouter always keeps call metadata (tokens, latency), never content | Nothing to delete for content; metadata goes with the OpenRouter account | Designed: Guard spec |
| Langfuse Cloud | Traces of Warden's own model calls. A Judge call's trace holds metadata only: model, tokens, cost, timing, outcome, and the Team id | Warden | Langfuse Cloud, EU region | Langfuse's free plan has no retention setting, so the metadata stays until Warden deletes the Langfuse project | Deleting the Langfuse project; nothing in it identifies a person or holds content | Designed: Guard spec (the first model call) |
| GitHub, through the GitHub app | The Team's own repos, which the app reads. With the write grant, the branches and Fix PRs the app opens | Team | GitHub | Fix PRs stay in the Team's repo until the Team closes them; Warden keeps no copy of a repo after a Scan | The Team closes a Fix PR and deletes its branch; uninstalling the app ends all access at once | Designed: Guard spec |
| The developer's laptop | Claude Code's managed hook settings: Warden's URL, the Team's hook token, which events the hook sends. Where a laptop runs safeagents, its `scrub` cleans events before they leave | Team (the settings); the developer (the events) | The developer's laptop | While the Admin keeps the managed settings in place | The Admin removes the managed settings; a rotated token stops working after 24 hours | Designed: Guard spec |
| The local keyring (development only) | Development copies of keys (Clerk now; OpenRouter and others later), read by a committed `.envrc` | The person developing Warden | The developer's own system keyring | While the developer needs them | `secret-tool clear service <name>` | Built: slice 1a (#4: `.envrc` and `.env.example`) |

Warden itself sends no product telemetry anywhere.

## Retention and deletion

- **Agent events** are kept only until their Agent session is judged, and at most 7 days in the live database.
  A daily job deletes the rest (designed, Guard spec).
- **Backups:** Cloud SQL keeps 7 automated backups, one a day, and 6 days of point-in-time recovery logs (built:
  slice 1b-ii, the setup script, #16). **So an Agent event lasts at most 15 days in any form:** up to 7 days live,
  up to 1 more until the daily delete job runs, then up to 7 days in a backup taken before it was dropped.
- **The preview database** holds seeded data only, never real Agent events or a Real-world run's data.
- **Kept for the life of the Team:** Agent session records, Findings with their masked evidence and hash, Status
  history and Role history. They're the audit evidence (ISA2027 5.2.4, that logs are checked; 4.2.1, that access
  rights are reviewed).
- **Deleting a Team:** an Admin deletes the Team's data. Its database rows go at once, its objects in Cloud Storage
  go at once, its hook token and pseudonym key are destroyed, and its Clerk Organization is deleted. Point-in-time
  recovery logs age out within 6 days, and backups within 7. The deletion job itself is **not yet planned**: no
  spec holds it yet (an open question below).
- **A person leaving:** history keeps their Clerk user id, never their name or email. The dashboard reads names from
  Clerk when it shows them. Once Clerk deletes the person, history shows "former member".
- **Cloud Logging:** Warden keeps the `_Default` bucket's 30 days. Every log line Warden writes passes through the
  redactor built in slice 1a (#4). Logs never hold an Agent event's content, a hook token, a secret value or a
  session token.

## What leaves the machine

Each outside service, what Warden sends it, and when.

- **Clerk:** identity and membership. When a person signs in, Clerk holds their name, email and sessions; Warden
  sends Clerk the Clerk Organization changes an Admin makes (invitations, `org:admin` for a Warden Admin). Built in
  part (slice 1a, #4: sign-in; slice 5b, #30: the Admin sync, a person's user id, Organization id and new Clerk
  role, sent when they're made Admin or stop being one, when their current Role is set again, and when someone Clerk
  calls `org:admin` joins as a Member); designed (slice 10: the Organization switcher).
- **OpenRouter:** the redacted Agent events and repo text the Judge reads, and nothing else, once per Judge call
  (designed, Guard spec).
  - **Before the first Judge call,** Warden's operator (whoever runs Warden) sets its OpenRouter account, on its privacy settings page
    (openrouter.ai/settings/privacy), to refuse providers that train on or keep prompts:
    - the training settings for paid and for free models are off, so OpenRouter won't route to providers that train;
    - Zero Data Retention is enforced for every model group (Anthropic, OpenAI, Google and "All other models"),
      with "ZDR only" rather than "Allow Safety Retention";
    - "OpenRouter Use of Inputs/Outputs" and "Private Input & Output Logging" stay off (both are off by default).
  - Each Judge call also asks for the same per request, with `provider: { "zdr": true, "data_collection": "deny" }`,
    so a changed account setting can't quietly widen it.
  - **The spending limit** is the OpenRouter key's $15 cap, set at OpenRouter. Per-Team limits and a call budget per
    run sit under it (see the threat model).
  - **The local-model option** for the Judge (a secure default) is designed: when a Team turns it on, the Judge calls a
    model the Team runs itself, and nothing goes to OpenRouter (Guard spec).
- **Langfuse:** traces of Warden's own model calls. A Judge call's trace sends metadata only (model, tokens, cost,
  timing, outcome), never its input or output, so judge-then-drop holds there too (designed, Guard spec).
- **GitHub:** what the app reads, which is the Team's repos with read-only permissions (the threat model names
  them); and, with the Team's write grant, the branches and Fix PRs it opens (designed, Guard spec).

## Data minimisation, and Warden never ranks people

The owner's rules for what Warden keeps about people and their work:

- **Redact on arrival, always,** at every Privacy tier. That includes the developer's home folder name in `cwd`,
  `transcript_path`, and every path in the tool input and tool output, which would otherwise name the person
  (designed, Guard spec).
- **Safeagents scrubs on the laptop** where it runs, before events leave (designed, Guard spec).
- **Judge, then drop.** Agent events are deleted once judged, and never kept past 7 days (designed, Guard spec).
- **A flagged session's Finding keeps only** the masked events the Judge used, and a SHA-256 hash of the redacted
  events it read, in order. The hash is of the redacted text, not the raw text, so a short secret can't be confirmed
  by guessing it and hashing (designed, Guard spec).
- **Evidence never holds a secret's value:** path, line, type and a mask only (built, slice 6, #11, Finding v1).
- **Developers are pseudonymous** unless an Admin turns names on for the Team (designed, Guard spec).
- **Warden has no per-developer score, ranking or leaderboard,** and no view that sorts people by their Findings
  (designed: every dashboard spec keeps to it, from slice 9 on).

## The pseudonym

An Agent session names a pseudonymous developer, not a person (designed, Guard spec).

- **How it's made:** `HMAC-SHA256(team key, developer identifier)`, with a key per Team kept in Secret Manager.
- **What that gives:** the same developer gets the same pseudonym within a Team, and a different one in another
  Team. Someone with database access but without the key can't reverse it by guessing names and hashing them.
- **The developer identifier:** Claude Code's `http` hook body carries **no** developer identifier. Its common
  fields are `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, and
  `agent_id` and `agent_type` for a subagent; none of them names the person. The hook can add request headers whose
  values come from environment variables on the laptop, but only variables listed in the hook's `allowedEnvVars`
  (and, in managed settings, `httpHookAllowedEnvVars`). So the identifier has to come from such a header, set in the
  managed settings. Which variable, and how it's tied to a Clerk user when an Admin turns names on, is an **open
  question for the Guard spec**. The value is whatever the laptop's environment says, so it identifies a developer
  only as far as the laptop is trusted.

## The Privacy tier

How much of an Agent session's content the hook sends to Warden, set per Team by an Admin. Warden redacts what
arrives, whatever the tier (designed, Guard spec).

- **Metadata:** tool names and outcomes.
- **Details (the default):** also commands, file paths and URLs.
- **Content:** also tool output and prompts.

Claude Code's hook sends every field of each event it's set for: a tool event always carries the tool's input
(its command, path or URL), and its result carries the tool's output. So the tier is kept in two places: the
managed settings send only the events the tier needs (prompts only at Content), and the endpoint drops every field
above the tier before anything is stored. At Metadata and Details, content above the tier still leaves the laptop
and is dropped on arrival.
