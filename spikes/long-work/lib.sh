# Shared by up.sh, down.sh and measure.sh: sourced, never run on its own. Throwaway (#14), never merged.
# shellcheck shell=bash

PROJECT=coherent-bay-515713-r7
REGION=europe-west1
PREFIX=spike-long-work
LABELS=purpose=spike-long-work

# Every gcloud call goes to Warden's project, whatever the local default is, and never stops to ask.
export CLOUDSDK_CORE_PROJECT=$PROJECT
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

SA_NAME=$PREFIX
SA=$SA_NAME@$PROJECT.iam.gserviceaccount.com
REPO=$PREFIX
SECRET=$PREFIX-secret
QUEUE=$PREFIX
JOB=$PREFIX-job
SCHEDULER=$PREFIX-daily
SERVICE_THROTTLED=$PREFIX-throttled # request-based billing: CPU only during requests (the default)
SERVICE_ALWAYS=$PREFIX-always       # instance-based billing: --no-cpu-throttling
SERVICE_TIMEOUT=$PREFIX-timeout     # --timeout=60, for the request limit
SERVICES=("$SERVICE_THROTTLED" "$SERVICE_ALWAYS" "$SERVICE_TIMEOUT")

# The six APIs the spike uses. The ticket names five; the IAM API (iam.googleapis.com) is also needed to create
# the service account, and it is off on the project (checked 2026-11-24).
REQUIRED_APIS=(
  run.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  cloudtasks.googleapis.com
  cloudscheduler.googleapis.com
  iam.googleapis.com
)

SPIKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RESULTS_DIR=${RESULTS_DIR:-$SPIKE_DIR/results}

# Everything the script prints also goes to results/<UTC time>-<name>.log, as it was printed.
start_log() {
  mkdir -p "$RESULTS_DIR"
  LOG_FILE="$RESULTS_DIR/$(date -u +%Y-%m-%dT%H%M%SZ)-$1.log"
  exec > >(tee -a "$LOG_FILE") 2>&1
  echo "# $1, started $(date -u +%Y-%m-%dT%H:%M:%SZ), project $PROJECT, region $REGION"
}

say() { echo "[$(date -u +%H:%M:%S)] $*"; }

ENABLED_APIS=""
load_enabled_apis() { ENABLED_APIS=$(gcloud services list --enabled --format='value(config.name)'); }
api_on() { grep -qxF "$1" <<<"$ENABLED_APIS"; }

# One line per spike resource still there, as "kind name". A kind whose API is off can hold nothing, so it's
# skipped. A failing list command stops the script (set -e), so a broken listing never reads as "none".
leftovers() {
  local out
  # Service accounts are always listed: on Warden's project they list fine while iam.googleapis.com isn't
  # in the enabled list (checked 2026-11-24).
  out=$(gcloud iam service-accounts list --format='value(email)')
  grep "^$PREFIX@" <<<"$out" | sed 's/^/service-account /' || true
  if api_on secretmanager.googleapis.com; then
    out=$(gcloud secrets list --format='value(name.basename())')
    grep "^$PREFIX" <<<"$out" | sed 's/^/secret /' || true
  fi
  if api_on artifactregistry.googleapis.com; then
    out=$(gcloud artifacts repositories list --location="$REGION" --format='value(name.basename())')
    grep "^$PREFIX" <<<"$out" | sed 's/^/repository /' || true
  fi
  if api_on run.googleapis.com; then
    out=$(gcloud run services list --region="$REGION" --format='value(metadata.name)')
    grep "^$PREFIX" <<<"$out" | sed 's/^/run-service /' || true
    out=$(gcloud run jobs list --region="$REGION" --format='value(metadata.name)')
    grep "^$PREFIX" <<<"$out" | sed 's/^/run-job /' || true
  fi
  if api_on cloudtasks.googleapis.com; then
    out=$(gcloud tasks queues list --location="$REGION" --format='value(name.basename())')
    grep "^$PREFIX" <<<"$out" | sed 's/^/queue /' || true
  fi
  if api_on cloudscheduler.googleapis.com; then
    out=$(gcloud scheduler jobs list --location="$REGION" --format='value(name.basename())')
    grep "^$PREFIX" <<<"$out" | sed 's/^/scheduler-job /' || true
  fi
}

service_url() { gcloud run services describe "$1" --region="$REGION" --format='value(status.url)'; }
