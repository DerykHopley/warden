# Secure defaults

Accepted at kickoff on 2026-11-23, from rig's secure-defaults list. Each accepted default becomes an acceptance
criterion, with a `Check:`. The walking skeleton takes the defaults the first deploy needs (marked **skeleton**).
Each of the others goes to the first ticket that brings its trait in.

| Trait | Why Warden has it | Default | Answer |
|---|---|---|---|
| Public URL | Cloud Run web app | Security headers on every response: CSP, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` (**skeleton**). The CSP's `img-src` allows `data:` images, because Clerk's sign-in shows a `data:` SVG; an image can't run script (#73) | yes |
| | | Rate limits on sign-in and on every paid or slow path | yes |
| | | Cloud Run runs as its own least-privilege service account, never the default one (**skeleton**) | yes |
| Paid model calls | Judge, chat and assessments through OpenRouter | A spending cap set at OpenRouter (**skeleton**) | yes |
| | | Per-Team limits that count every spending path (chat, judge, retries, Scans), with a test for each path | yes |
| | | A call budget per run, so one loop can't spend the month | yes |
| An LLM reads outside text | Traces, repo files, policy documents, CVE text | Outside text goes into prompts as tagged data, never as instructions | yes |
| | | Text that reads like instructions is flagged | yes |
| | | An injection fixture with a test that the app ignores it | yes |
| More than one user | Teams are Clerk Organizations | Authorization per object: a test that Team B can't read or change Team A's Findings | yes |
| | | Roles and permissions kept server-side, never trusted from the client | yes |
| Personal data or private code | Cohort repos, agent traces, Devices | Redaction on output and in logs, with a test; secret values are never stored, only masked (**skeleton** for logs) | yes |
| | | A retention period and a way to delete | yes |
| | | `docs/data.md` lists what leaves the machine (model provider, Langfuse, GitHub) | yes |
| | | A local-model option for the judge | yes |
| An audit trail | Finding status history, Vouch's review log | Append-only enforced in Postgres (a trigger or grants), with a test that an update or delete fails | yes |
| Secrets | OpenRouter, Clerk, Langfuse and GitHub keys | rig's default: keyring and a committed `.envrc` locally, names in `.env.example`; Secret Manager on the host | applies |
