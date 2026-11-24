#!/usr/bin/env bash
# The long-work spike's six measurements (#14), after up.sh. Each saves what it printed to
# results/<UTC time>-<name>.log, and the raw Cloud Logging entries it read to a .json beside it.
#
#   measure.sh all      m1 to m6 in order, about 40 minutes
#   measure.sh m1       work that outlives its request, CPU throttled and always allocated (about 18 minutes)
#   measure.sh m2       the request limit: 90 seconds of work on a --timeout=60 service (about 4 minutes)
#   measure.sh m3       Cloud Tasks: a retried delivery, and a task that outlives its dispatch deadline (about 5 minutes)
#   measure.sh m4       a Cloud Run Job: a 5-minute Scan, a retried attempt, a Scan with no Team (about 9 minutes)
#   measure.sh m5       Cloud Scheduler fires the daily job once by hand (about 2 minutes)
#   measure.sh m6       secrets: what the services and the job logged about the secret (seconds)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

what=${1:-}
if [[ $what == all ]]; then
  for step in m1 m2 m3 m4 m5 m6; do "$0" "$step"; done
  exit 0
fi
[[ $what =~ ^m[1-6]$ ]] || {
  echo "usage: $0 all|m1|m2|m3|m4|m5|m6" >&2
  exit 2
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# post SERVICE PATH JSON [MAX SECONDS]: a signed-in POST; prints the answer, its status and how long it took.
post() {
  local url identity
  url=$(service_url "$1")
  identity=$(gcloud auth print-identity-token)
  say "POST $1$2 $3"
  curl --silent --show-error --max-time "${4:-30}" -X POST \
    -H "Authorization: Bearer $identity" -H "Content-Type: application/json" -d "$3" \
    --write-out 'status=%{http_code} seconds=%{time_total}\n' "$url$2" || say "curl ended with exit code $?"
}

# logs NAME FILTER: the Cloud Logging entries matching FILTER, oldest first: raw JSON to a file, a readable
# table here.
logs() {
  local raw="${LOG_FILE%.log}-$1.json"
  gcloud logging read "$2" --order=asc --limit=5000 --format=json >"$raw"
  say "Cloud Logging, $1 (raw entries: $(basename "$raw")):"
  gcloud logging read "$2" --order=asc --limit=5000 --format='table[box](
    timestamp,
    jsonPayload.instance:label=INSTANCE,
    jsonPayload.message:label=MESSAGE,
    jsonPayload.scanId:label=SCAN,
    jsonPayload.tick:label=TICK,
    jsonPayload.gapMs:label=GAP_MS,
    jsonPayload.idleSeconds:label=IDLE_S,
    jsonPayload.uptimeSeconds:label=UP_S,
    jsonPayload.answer:label=ANSWER,
    jsonPayload.taskRetryCount:label=RETRY,
    jsonPayload.taskExecutionCount:label=EXEC,
    jsonPayload.attempt:label=ATTEMPT,
    jsonPayload.secret:label=SECRET,
    httpRequest.status:label=HTTP,
    httpRequest.latency:label=LATENCY,
    textPayload.slice(0:120):label=TEXT)'
}

service_filter() { echo "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$1\" AND timestamp>=\"$2\""; }
job_filter() { echo "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\" AND timestamp>=\"$1\""; }

case $what in
  m1)
    start_log m1-outlives-request
    since=$(now)
    say "Measurement 1: a request starts 5 minutes of ticks and returns at once."
    say "Run 1 on $SERVICE_THROTTLED (request-based billing, CPU only during requests)."
    say "Run 2 on $SERVICE_ALWAYS (instance-based billing, --no-cpu-throttling). Both at once."
    post "$SERVICE_THROTTLED" /start '{"scanId":"m1-run1-throttled","team":"spike-team","seconds":300}'
    post "$SERVICE_ALWAYS" /start '{"scanId":"m1-run2-always","team":"spike-team","seconds":300}'
    say "Waiting 18 minutes: 5 minutes of work, then up to 15 minutes before Cloud Run stops an idle instance, then log delay."
    sleep 1080
    logs run1-throttled "$(service_filter "$SERVICE_THROTTLED" "$since")"
    logs run2-always "$(service_filter "$SERVICE_ALWAYS" "$since")"
    ;;
  m2)
    start_log m2-request-limit
    since=$(now)
    say "Measurement 2: $SERVICE_TIMEOUT has --timeout=60; the request ticks for 90 seconds before answering."
    post "$SERVICE_TIMEOUT" /inline '{"scanId":"m2-inline-90s","team":"spike-team","seconds":90}' 150
    say "Waiting 2 minutes for the rest of the ticks, if any, and the log delay."
    sleep 120
    logs service "$(service_filter "$SERVICE_TIMEOUT" "$since")"
    ;;
  m3)
    start_log m3-cloud-tasks
    since=$(now)
    url=$(service_url "$SERVICE_THROTTLED")
    say "Measurement 3: queue $QUEUE calls $SERVICE_THROTTLED/task with $SA's OIDC token."
    gcloud tasks queues describe "$QUEUE" --location="$REGION" --format='yaml(rateLimits,retryConfig,state)'
    say "3a. A Scan whose first delivery gets 500: Cloud Tasks retries it with the same body."
    gcloud tasks create-http-task --queue="$QUEUE" --location="$REGION" \
      --url="$url/task" --method=POST \
      --oidc-service-account-email="$SA" --oidc-token-audience="$url" \
      --header="Content-Type: application/json" \
      --body-content='{"scanId":"m3-retry","team":"spike-team","seconds":0,"failFirstDelivery":true}' \
      --format='value(name)'
    say "3b. A Scan that works 40 seconds, with a 15-second dispatch deadline (the minimum). gcloud has no flag"
    say "    for the deadline, so this task goes through the Cloud Tasks REST API."
    body=$(printf '%s' '{"scanId":"m3-deadline","team":"spike-team","seconds":40}' | base64 -w0)
    token=$(gcloud auth print-access-token)
    curl --silent --show-error --fail-with-body -X POST \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
      -d "{\"task\":{\"dispatchDeadline\":\"15s\",\"httpRequest\":{\"url\":\"$url/task\",\"httpMethod\":\"POST\",\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"$body\",\"oidcToken\":{\"serviceAccountEmail\":\"$SA\",\"audience\":\"$url\"}}}}" \
      "https://cloudtasks.googleapis.com/v2/projects/$PROJECT/locations/$REGION/queues/$QUEUE/tasks"
    echo
    unset token
    say "Waiting 4 minutes: three 40-second attempts, 5 to 10 seconds apart, then log delay."
    sleep 240
    say "Tasks still in the queue:"
    gcloud tasks list --queue="$QUEUE" --location="$REGION" \
      --format='table(name.basename(),dispatchCount,responseCount,lastAttempt.responseStatus.message)'
    logs service "$(service_filter "$SERVICE_THROTTLED" "$since")"
    logs queue "resource.type=\"cloud_tasks_queue\" AND resource.labels.queue_id=\"$QUEUE\" AND timestamp>=\"$since\""
    ;;
  m4)
    start_log m4-cloud-run-job
    since=$(now)
    say "Measurement 4: $JOB, its settings:"
    gcloud run jobs describe "$JOB" --region="$REGION" \
      --format='yaml(spec.template.spec.taskCount,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.timeoutSeconds)'
    for scan in \
      '{"scanId":"m4-job-5min","team":"spike-team","seconds":300}' \
      '{"scanId":"m4-retry","team":"spike-team","seconds":10,"failFirstAttempt":true}' \
      '{"scanId":"m4-no-team","seconds":10}'; do
      say "Execute with SCAN=$scan (an env override at execution time), and wait for it"
      called=$(now)
      execution=$(gcloud run jobs execute "$JOB" --region="$REGION" --update-env-vars="^@^SCAN=$scan" \
        --wait --format='value(metadata.name)') || say "the execution failed (exit code $?)"
      say "called at $called, returned at $(now)"
      if [[ -n ${execution:-} ]]; then
        gcloud run jobs executions describe "$execution" --region="$REGION" \
          --format='yaml(metadata.name,metadata.creationTimestamp,status)'
      else
        gcloud run jobs executions list --job="$JOB" --region="$REGION" --limit=1 \
          --format='yaml(metadata.name,metadata.creationTimestamp,status)'
      fi
      execution=""
    done
    say "Waiting 1 minute for the log delay."
    sleep 60
    logs job "$(job_filter "$since")"
    ;;
  m5)
    start_log m5-daily-trigger
    since=$(now)
    say "Measurement 5: $SCHEDULER, fired once by hand; it calls the Cloud Run Admin API to run $JOB."
    gcloud scheduler jobs describe "$SCHEDULER" --location="$REGION" \
      --format='yaml(schedule,timeZone,httpTarget.uri,httpTarget.oauthToken,state)'
    gcloud scheduler jobs run "$SCHEDULER" --location="$REGION"
    say "Waiting 90 seconds for the execution (20 seconds of work) and the log delay."
    sleep 90
    say "Executions of $JOB, newest first:"
    gcloud run jobs executions list --job="$JOB" --region="$REGION" --limit=3 \
      --format='table(metadata.name,metadata.creationTimestamp,status.completionTime,status.succeededCount,status.failedCount)'
    logs scheduler "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"$SCHEDULER\" AND timestamp>=\"$since\""
    logs job "$(job_filter "$since")"
    ;;
  m6)
    start_log m6-secrets
    say "Measurement 6: what the services and the job logged about $SECRET (found and a length, never the value)."
    logs secret-lines "(resource.type=\"cloud_run_revision\" OR resource.type=\"cloud_run_job\") AND (resource.labels.service_name:\"$PREFIX\" OR resource.labels.job_name=\"$JOB\") AND jsonPayload.secret:* AND timestamp>=\"$(date -u -d '-1 day' +%Y-%m-%dT%H:%M:%SZ)\""
    ;;
esac
say "Log: $LOG_FILE"
