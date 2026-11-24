#!/usr/bin/env bash
# Creates every resource of the long-work spike (#14) on Warden's project, in europe-west1. Fire and forget: it
# stops at the first error. down.sh deletes whatever exists, so it can always be run after a failed up.sh.
#
# Run only after the owner's go on #14. Needs gcloud signed in with access to the project, and podman or docker.
# Every resource is named spike-long-work*, labelled purpose=spike-long-work where it takes labels, private,
# and run as the spike's own service account. Nothing touches warden-db, warden-db-password or slice 1b.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
start_log up

say "Checking the APIs the spike uses, before anything else"
load_enabled_apis
missing=()
for api in "${REQUIRED_APIS[@]}"; do api_on "$api" || missing+=("$api"); done
if ((${#missing[@]})); then
  say "Refusing to start, nothing created: these APIs are off on $PROJECT: ${missing[*]}"
  say "The owner enables them with: gcloud services enable ${missing[*]} --project=$PROJECT"
  exit 1
fi

say "Checking nothing is left from an earlier run"
left=$(leftovers)
if [[ -n $left ]]; then
  say "Refusing to start, nothing created: spike resources already exist. Run down.sh first."
  echo "$left"
  exit 1
fi

CONTAINER=${CONTAINER:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}
IMAGE=$REGION-docker.pkg.dev/$PROJECT/$REPO/$PREFIX:$(date -u +%Y%m%d-%H%M%S)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
TASKS_AGENT=service-$PROJECT_NUMBER@gcp-sa-cloudtasks.iam.gserviceaccount.com
say "gcloud: $(gcloud --version 2>/dev/null | head -1); container tool: $CONTAINER; image: $IMAGE"

# IAM changes take a little while to be seen everywhere: retry a few times before giving up.
retry() {
  local tries=0
  until "$@"; do
    tries=$((tries + 1))
    if ((tries >= 6)); then return 1; fi
    say "not ready yet, retrying in 10 seconds ($tries of 5)"
    sleep 10
  done
}

say "1. Service account $SA (no project-level roles: every grant below is on one spike resource)"
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Long-work spike (#14), throwaway" \
  --description="purpose=spike-long-work; deleted by down.sh"
retry gcloud iam service-accounts describe "$SA" --format='value(email)'

say "2. Secret $SECRET: a random value, piped straight in, never printed"
openssl rand -hex 24 | tr -d '\n' | gcloud secrets create "$SECRET" \
  --replication-policy=user-managed --locations="$REGION" --labels="$LABELS" --data-file=-
retry gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --format=none

say "3. Artifact Registry repository $REPO, and the image built locally and pushed"
gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" \
  --labels="$LABELS" --description="Long-work spike (#14), throwaway"
"$CONTAINER" build --platform=linux/amd64 --tag="$IMAGE" "$SPIKE_DIR"
gcloud auth print-access-token |
  "$CONTAINER" login --username=oauth2accesstoken --password-stdin "$REGION-docker.pkg.dev"
"$CONTAINER" push "$IMAGE"
"$CONTAINER" logout "$REGION-docker.pkg.dev"

say "4. Three services, all private (--no-allow-unauthenticated), one instance at most"
common=(
  --image="$IMAGE" --region="$REGION" --service-account="$SA" --no-allow-unauthenticated
  --labels="$LABELS" --set-secrets="SPIKE_SECRET=$SECRET:1" --args=serve
  --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi --concurrency=10
)
gcloud run deploy "$SERVICE_THROTTLED" "${common[@]}" --cpu-throttling --timeout=300
gcloud run deploy "$SERVICE_ALWAYS" "${common[@]}" --no-cpu-throttling --timeout=300
gcloud run deploy "$SERVICE_TIMEOUT" "${common[@]}" --cpu-throttling --timeout=60
# Cloud Tasks calls the throttled service with the spike account's OIDC token.
retry gcloud run services add-iam-policy-binding "$SERVICE_THROTTLED" --region="$REGION" \
  --member="serviceAccount:$SA" --role=roles/run.invoker --format=none

say "5. Cloud Run Job $JOB: one task, one retry, no Scan until an execution passes one"
gcloud run jobs create "$JOB" --image="$IMAGE" --region="$REGION" --service-account="$SA" \
  --labels="$LABELS" --set-secrets="SPIKE_SECRET=$SECRET:1" --args=job \
  --tasks=1 --max-retries=1 --task-timeout=10m --cpu=1 --memory=512Mi
# Cloud Scheduler starts it with overrides, as the spike account.
retry gcloud run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:$SA" --role=roles/run.jobsExecutorWithOverrides --format=none

say "6. Cloud Tasks queue $QUEUE: 3 attempts, 5 to 10 seconds apart, every attempt logged"
# The Cloud Tasks service agent mints the OIDC token, so it may act as the spike account (on that account only).
# generateServiceIdentity makes sure the agent exists; it's a no-op when it does.
token=$(gcloud auth print-access-token)
curl --silent --show-error --fail --output /dev/null -X POST \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{}' \
  "https://serviceusage.googleapis.com/v1beta1/projects/$PROJECT_NUMBER/services/cloudtasks.googleapis.com:generateServiceIdentity"
unset token
retry gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$TASKS_AGENT" --role=roles/iam.serviceAccountUser --format=none
gcloud tasks queues create "$QUEUE" --location="$REGION" \
  --max-attempts=3 --min-backoff=5s --max-backoff=10s --max-doublings=0 --log-sampling-ratio=1.0

say "7. Cloud Scheduler job $SCHEDULER: daily at 04:00 UTC, starts $JOB through the Cloud Run Admin API"
gcloud scheduler jobs create http "$SCHEDULER" --location="$REGION" \
  --schedule="0 4 * * *" --time-zone=Etc/UTC \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run" \
  --http-method=POST --oauth-service-account-email="$SA" \
  --headers=Content-Type=application/json \
  --message-body='{"overrides":{"containerOverrides":[{"env":[{"name":"SCAN","value":"{\"scanId\":\"m5-daily-expiry\",\"team\":\"spike-team\",\"seconds\":20}"}]}]}}'

say "8. Access check: no service answers without a Google identity"
identity=$(gcloud auth print-identity-token)
for service in "${SERVICES[@]}"; do
  url=$(service_url "$service")
  anonymous=$(curl --silent --output /dev/null --write-out '%{http_code}' "$url/")
  signed_in=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -H "Authorization: Bearer $identity" "$url/")
  say "$service: $anonymous without a token, $signed_in with the owner's identity token ($url)"
  if [[ $anonymous != 403 ]]; then
    say "STOP: $service answered $anonymous without a token. Run down.sh now."
    exit 1
  fi
done
unset identity

say "Done. Every spike resource:"
leftovers
say "Next: measure.sh, then down.sh. Log: $LOG_FILE"
