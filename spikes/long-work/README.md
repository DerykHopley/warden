# Long-work spike (#14)

Throwaway, on branch `prototype/long-work-spike`, never merged. It measures where Warden's Scans and daily jobs
can run on Cloud Run, for ADR 0009: **A** in-process in a service, **B** Cloud Tasks calling back, **C** a Cloud
Run Job, with Cloud Scheduler as the daily trigger.

## What's here

- `src/work.ts`: the stand-in Scan (a plain JSON value with a Scan id and a Team) and its work, a tick every
  10 seconds. A Scan with no Team is refused.
- `src/main.ts`: one program, two modes. `serve` is a Cloud Run service (`/start` answers at once and keeps
  working, `/inline` works inside the request, `/task` is the Cloud Tasks callback). `job` runs the Scan in the
  `SCAN` env var and exits. It logs one JSON line per event, and only "found, length N" about the secret.
- `Dockerfile`: the image, built locally (no Cloud Build).
- `up.sh`, `measure.sh`, `down.sh`, sharing `lib.sh`. Project `coherent-bay-515713-r7`, region `europe-west1`,
  every name `spike-long-work*`, every labelled resource `purpose=spike-long-work`.
- `results/`: each run's log as printed, and the raw Cloud Logging entries it read.
- `test/`: the scripts' tests, against a fake `gcloud`, `curl` and `podman`.

## Running it (only after the owner's go on #14)

```sh
spikes/long-work/up.sh            # about 10 minutes: checks six APIs first, creates nothing if one is off
spikes/long-work/measure.sh all   # about 40 minutes: measurements 1 to 6
spikes/long-work/down.sh          # a few minutes: deletes it all, fails if anything named spike-long-work is left
```

`down.sh` is safe at any time, including after a failed `up.sh`. Cloud Tasks keeps a deleted queue's name for
about 7 days, so `up.sh` can't run again within a week of `down.sh` without renaming the queue.

## Tests

```sh
node --test --test-timeout=30000 "spikes/long-work/src/*.test.ts" "spikes/long-work/test/*.test.ts"
```
