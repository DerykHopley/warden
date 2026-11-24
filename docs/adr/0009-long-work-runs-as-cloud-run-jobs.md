# Long work runs as Cloud Run Jobs, started by Warden or by Cloud Scheduler

Work that can outlive a request runs as a Cloud Run Job execution: one execution per Scan, built from Warden's own
image. A Scan someone starts is a Cloud Run Admin API call from Warden's service. The daily jobs are started by
Cloud Scheduler. Nothing long runs in the service after it answers, and nothing calls back into Warden over HTTP.

| Work | Where it runs | What starts it |
|---|---|---|
| A Scan started by a request (a Lead's "scan now", a webhook) | One execution of the Scan job | Warden's service, after the Role check (ADR 0008), through `jobs.run` with the Scan's id and Team as an override |
| The daily expiry job (reopens Accepted Findings past their expiry) | One execution of the daily job | Cloud Scheduler, once a day, through `jobs.run` |
| Patch's CVE refresh (provisional: Patch spec) | The daily job, or its own scheduled job | Cloud Scheduler; one Scan per Team, as the glossary's Scan says |
| The Judge (provisional: Guard spec) | One execution per Spot run over a Team's Agent sessions | Warden's service when a session ends, plus a scheduled sweep for any missed |

## How

- **One image, two entry points.** The service runs `server/src/index.ts`; the jobs run a job entry point from the same
  image, with the same Cloud SQL connection. The deploy pipeline updates both jobs' images on each release, or a job
  keeps running the old code.
- **What a queued Scan holds, and where.** Warden writes the Scan's request (module, Assets, Rules) to Cloud SQL
  under its Team, then starts the execution with an env override holding only `{scanId, team}`. Team data stays in
  Cloud SQL. The execution record holds two ids. ADR 0005's Scan value is read back whole by the job from its row.
- **Its Team.** The job reads the Team from its override and does all its database work inside
  `withTeam(team, …)` (ADR 0006). A Scan with no Team is refused before the job touches the database, and the job
  exits non-zero. The daily expiry job spans Teams: it lists Team ids in the one marked admin place (`withAdmin`,
  read only), then runs each Team's expiry inside `withTeam` for that Team. So every write stays under row-level
  security, and the admin role can only read ids: select on `teams (id)` is its one grant. Each Team's transaction
  gives up after 30 s waiting for its lock or 60 s on a statement. One Team failing is logged and doesn't stop the
  rest; an empty Team list is logged as a warning, as it is also what a missing admin policy looks like. It runs as
  its own service account, `warden-daily`, not `warden-run`: only it reads the admin role's password, so the server
  can't list Teams (#36). Its entry point is `server/src/daily-expiry.ts`.
- **A retry is harmless.** The job runs with `--max-retries=1` and a retry runs the same Scan id. `reconcile` checks
  the Scan id in the `scans` table, keyed by `(team_id, id)`, inside the transaction that applies the Scan. A Scan
  id already applied changes nothing (built in slice 7, #22). The job adds no check of its own. The daily expiry is
  harmless twice over: a Finding already reopened isn't reopened again. A refused Scan is retried and refused again, at about 30
  seconds of cost (measured), so a refusal still shows as a failed execution.
- **Past the limit.** A task runs up to its task timeout: 10 minutes by default, 168 hours at most. Warden sets
  1 hour for Scans. At the timeout Cloud Run sends SIGTERM, then SIGKILL 10 seconds later. The attempt counts as
  failed and is retried. A Scan's writes commit together at the end (ADR 0005: a crash inside the callback writes
  nothing), so a killed attempt leaves nothing half-done. A Scan that can't finish in an hour is split into several
  Scans, as ADR 0005 already says.
- **Secrets and who may start it.** Each job runs as Warden's own runtime service account (slice 1b), never the
  default compute account. It reads secrets through `--set-secrets` from Secret Manager, pinned to a version (Cloud
  Run's advice), with `roles/secretmanager.secretAccessor` on each secret it needs. Who may start each job:
  - Warden's service account, with `roles/run.jobsExecutorWithOverrides` on the Scan job only. `roles/run.invoker`
    can't pass overrides.
  - Cloud Scheduler's service account, with the same role on the daily job only.
  - No one else. People start Scans through Warden's API, which checks their Role.
- **No callback endpoint.** Nothing calls into Warden's public service from a queue, so no endpoint has to refuse a
  caller without a Google OIDC token. Option B would have needed one (below).

## Why

A throwaway spike measured three options on the real project on 2026-11-24. It ran 1 vCPU, 512 MiB, Node 24 and
a "Scan" that logs a tick every 10 seconds.

- **A, in-process, answered and kept working.**
  - With CPU throttled, 30 of 30 ticks arrived, with gaps from 9,872 to 10,092 ms. With CPU always allocated, gaps
    ran from 9,966 to 10,002 ms.
  - Both instances got SIGTERM about 15 minutes (907 s and 909 s) after their last request, so a Scan running
    longer than that would be killed with no retry.
  - A tick needs almost no CPU, so the throttled run shows the instance stays alive, not that real work gets CPU.
    Cloud Run's docs say CPU is allocated only during requests.
  - Inside a request, the 60-second limit cut the caller off with a 504 at 60.4 s. The work ran on to 90 s, and
    nothing told it the caller had gone.
- **B, Cloud Tasks calling back, retried correctly.** The first delivery got 500 (retry count 0), and the same Scan
  came back 5 s later (retry count 1, previous response 500). But its dispatch deadline is 30 minutes at most. With
  a 15 s deadline on 40 s of work, Cloud Tasks gave up on each of three attempts at 15.0 s (`DEADLINE_EXCEEDED`),
  while each handler ran its full 40 s, so the attempts overlapped: at most two copies of one Scan ran at the same
  time.
- **C, a Cloud Run Job, ran a 5-minute Scan to the end** and exited 0.
  - **Start-up:** the first log line came 15 to 29 s after the execute call.
  - **Retry:** a failed first attempt ran the same Scan id again 27 s later (`retriedCount: 1`).
  - **No Team:** a Scan with no Team was refused on both attempts.
  - **Daily trigger:** Cloud Scheduler, fired by hand, started an execution through the Admin API (HTTP 200,
    execution created 3 s later, succeeded).
  - **Secrets:** the services and the job each read the secret, and logged only "found, length 48" (9 of 9 lines).

C is the only option with a limit far past a Scan's length, retries built in, and no HTTP endpoint to secure. Its
cost is a 15 to 29 s start, which a Scan of minutes doesn't notice.

### Limits that apply (docs checked 2026-11-24)

| Limit | Value | Source |
|---|---|---|
| Cloud Run request timeout | 5 min default, 60 min max; a 504 at the limit, and the instance isn't stopped | https://docs.cloud.google.com/run/docs/configuring/request-timeout |
| Idle instance | stopped at most 15 min after its last request; SIGTERM, then SIGKILL after 10 s | https://docs.cloud.google.com/run/docs/configuring/billing-settings, https://docs.cloud.google.com/run/docs/container-contract |
| Job task timeout | 10 min default, 168 h max | https://docs.cloud.google.com/run/docs/configuring/task-timeout |
| Job retries | `--max-retries` 3 default, 0 to 10, per task | https://docs.cloud.google.com/run/docs/configuring/max-retries |
| Starting a job with overrides | `run.jobs.runWithOverrides`, in `roles/run.jobsExecutorWithOverrides`, not in `roles/run.invoker` | https://docs.cloud.google.com/run/docs/reference/iam/roles |
| Cloud Scheduler starting a job | POST `run.googleapis.com/v2/…/jobs/JOB:run` with an OAuth token | https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule |
| Cloud Tasks dispatch deadline (B) | 10 min default, 15 s to 30 min; past it the attempt fails and is retried, and the handler isn't stopped | https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks |

### Monthly cost at Warden's expected load

The load: one cohort of about 20 people, about 10 Scans a day of about 5 minutes each, and one daily job of about
2 minutes. That is about 93,600 vCPU-s and 46,800 GiB-s a month at 1 vCPU and 512 MiB.

The prices were checked 2026-11-24 from Google's pricing pages, as quoted in search excerpts: those pages render
their figures with JavaScript.

- https://cloud.google.com/run/pricing: europe-west1 is Tier 1.
  - Instance-based billing (jobs): $0.000018 per vCPU-s and $0.000002 per GiB-s. Free each month: 240k vCPU-s and
    450k GiB-s.
  - Request-based billing: $0.000024 per vCPU-s and $0.0000025 per GiB-s. Free each month: 180k vCPU-s and 360k
    GiB-s.
- https://cloud.google.com/scheduler/pricing: $0.10 per job a month; 3 jobs free per billing account.
- https://cloud.google.com/tasks/pricing: 1M operations free a month.

| Option | Without free tiers | With free tiers |
|---|---|---|
| **C, Jobs and Scheduler (chosen)** | $1.78 compute, plus $0.10 to $0.20 for 1 or 2 Scheduler jobs | $0.00; unverified whether jobs draw on the instance-based free tier |
| B, Cloud Tasks | $2.36 compute; Tasks operations free | $0.00 |
| A, in-process, CPU always allocated | about $16: the service is billed while any instance lives, about 8 hours a day plus 15-minute idle tails | about $11 |

Each fits easily in the free-trial credit: about $258, with about 55 days left on 2026-11-24.

**The spike's own cost:** the resources lived 38 minutes, using about 1,450 instance-based vCPU-s and a few minutes
of request time. Its cost: $0.00 reported on the day; estimate ~$0.03 before free tiers. The owner read the billing
report after tear-down (#14).

## Considered options

- **A, in-process after the response:**
  - No retry, and the instance goes about 15 minutes after its last request.
  - With CPU throttled, Cloud Run gives no CPU outside requests.
  - With CPU always allocated, the dashboard's service is billed for as long as any instance is up, idle or not.
  - Kept only for work that fits inside a request (seconds).
- **B, Cloud Tasks calling back with an OIDC token:**
  - Retries work.
  - The 30-minute dispatch deadline caps a Scan, and a slow attempt overlaps its own retries.
  - Warden's service is public (for the dashboard), so Cloud Run doesn't check the token. Warden would have to verify
    the Google-signed OIDC token itself: the signature, `aud` equal to the endpoint's URL, and `email` equal to the
    queue's service account.
  - Each task's body, a Scan with its Team, would be stored in Cloud Tasks outside Cloud SQL.
- **Cloud Scheduler calling Warden's HTTP endpoint for the daily job:** the same open-endpoint problem as B.

## Consequences

- **Cloud Scheduler is a new outside service,** and the owner approved it on #14. Cloud Run
  Jobs are part of Cloud Run, already chosen. The Cloud Tasks API was turned on for the spike only and isn't used;
  the owner may turn it off.
- **Who builds what:**
  - Slice 8 builds the daily expiry job, its entry point and its Scheduler trigger.
  - The first spec that starts Scans from a request (the Guard spec, with its scanners) builds the Scan job and the
    queued-Scan row in Cloud SQL.
  - The Scan id check is already built (slice 7, #22).
  - Slice 1b's release pipeline needs a step that updates the jobs' images on each release.
- **`docs/data.md` gains a row,** added by whichever of those lands first: "Cloud Run job executions: each
  execution's env override (a Scan id and a Team id; none for the daily job) and its logs, kept as Cloud Run keeps
  executions". How long Cloud Run keeps executions is unverified; that slice checks it.
- **A Scan takes 15 to 29 s longer to start** than it would in-process. The dashboard shows a queued Scan as
  started, not done.
- **A new word, "Job",** is in GLOSSARY.md, accepted by the owner on #1.

Spike code and results: branch `prototype/long-work-spike`, `spikes/long-work/` (the results are summarised in
`spikes/long-work/results/README.md`).
