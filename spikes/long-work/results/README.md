# Long-work spike results (2026-11-24)

The spike ran on `coherent-bay-515713-r7`, europe-west1, 14:37 to 15:15 UTC. It ran after the owner's go on #14,
posted 14:36:42 UTC. `.log` files are what each script printed. `.json` files are the raw Cloud Logging entries
each one read; only their whitespace was changed, by prettier. `tidy-results.ts` replaced local paths and the
gcloud account's email.

**Every service ran with 1 vCPU, 512 MiB, at most 1 instance and Node 24. A "tick" is a log line every
10 seconds, which uses almost no CPU.** So these runs show whether work stays alive, not how much CPU it gets.

| # | File | What it showed |
|---|---|---|
| — | `…140923Z-down.log` | `down.sh` before anything existed: nothing to delete, exit 0 |
| — | `…143705Z-up.log` | 9 resources created. All three services answered **403** without a token and 200 with the owner's identity token |
| 1 | `…143923Z-m1-outlives-request.log` | `/start` answered 202 in 0.07 s and then ticked for 5 min. **CPU throttled:** 30 of 30 ticks, gaps 9,872 to 10,092 ms. **CPU always allocated:** 30 of 30 ticks, gaps 9,966 to 10,002 ms. Neither instance was stopped mid-work. Both got SIGTERM after **907 s and 909 s** idle (about 15 min after the last request) |
| 2 | `…145731Z-m2-request-limit.log` | With `--timeout=60`, the caller got **504 "upstream request timeout" at 60.4 s**. The work kept ticking to 90 s and finished, and the program never saw the caller leave |
| 3 | `…150034Z-m3-cloud-tasks.log` | **Retry:** `m3-retry` got 500 (retry count 0), then 200 five seconds later (retry count 1, previous response 500), with the same Scan id. **Deadline:** a 15 s dispatch deadline on 40 s of work gave three attempts, each `DEADLINE_EXCEEDED` at about 15.0 s, and then the task was dropped. Each handler still ran its full 40 s, so attempts overlapped |
| 4 | `…150443Z-m4-cloud-run-job.log` | **5-minute Scan:** ran to the end and exited 0. It started 21 s after the execute call (execution created 1.5 s, started 3.3 s). **`failFirstAttempt`:** attempt 0 exited 1, and attempt 1 ran the same Scan 27 s later; `retriedCount: 1`. **No Team:** refused on both attempts (exit 2) |
| 5 | `…151316Z-m5-daily-trigger.log` | The Scheduler job, fired by hand at 15:13:16, got a 200 from the Admin API. Execution `spike-long-work-job-rpwpx` was created at 15:13:19 and succeeded |
| 6 | `…151453Z-m6-secrets.log` | 9 lines (5 service instances, 4 job attempts), each `secret found, length 48`. The value was never logged |
| — | `…151506Z-down.log` | 9 resources deleted; leftover listing empty |
| — | `…151554Z-leftover-check.log` | The ticket's seven list commands: none named `spike-long-work` |
