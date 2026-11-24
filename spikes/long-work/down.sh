#!/usr/bin/env bash
# Deletes every resource of the long-work spike (#14). Safe to run at any time, including after a failed up.sh
# or with nothing there: it skips what doesn't exist. It deletes only the spike's own names, never anything else.
# It ends by listing what's left named spike-long-work, and fails if anything is.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
start_log down

load_enabled_apis

# delete_if_there LABEL NAME GROUP SUBGROUP [LOCATION FLAG]: describe first, delete only what's there.
delete_if_there() {
  local label=$1 name=$2 group=$3 subgroup=$4
  shift 4
  if gcloud "$group" "$subgroup" describe "$name" "$@" --format='value(name)' >/dev/null 2>&1; then
    gcloud "$group" "$subgroup" delete "$name" "$@"
    say "deleted $label $name"
  else
    say "$label $name: not there, skipped"
  fi
}

if api_on cloudscheduler.googleapis.com; then
  delete_if_there "scheduler job" "$SCHEDULER" scheduler jobs --location="$REGION"
else
  say "Cloud Scheduler API is off: no scheduler job to delete"
fi

if api_on cloudtasks.googleapis.com; then
  # A deleted queue's name can't be used again for about 7 days (Cloud Tasks).
  delete_if_there "queue" "$QUEUE" tasks queues --location="$REGION"
else
  say "Cloud Tasks API is off: no queue to delete"
fi

if api_on run.googleapis.com; then
  delete_if_there "run job" "$JOB" run jobs --region="$REGION"
  for service in "${SERVICES[@]}"; do
    delete_if_there "run service" "$service" run services --region="$REGION"
  done
else
  say "Cloud Run API is off: no service or job to delete"
fi

if api_on artifactregistry.googleapis.com; then
  # Deleting the repository deletes the images in it.
  delete_if_there "repository" "$REPO" artifacts repositories --location="$REGION"
else
  say "Artifact Registry API is off: no repository to delete"
fi

if api_on secretmanager.googleapis.com; then
  if gcloud secrets describe "$SECRET" --format='value(name)' >/dev/null 2>&1; then
    gcloud secrets delete "$SECRET"
    say "deleted secret $SECRET"
  else
    say "secret $SECRET: not there, skipped"
  fi
else
  say "Secret Manager API is off: no secret to delete"
fi

# Its grants were all on spike resources, deleted above, or on itself. Not gated on the IAM API: see lib.sh.
delete_if_there "service account" "$SA" iam service-accounts

left=$(leftovers)
if [[ -n $left ]]; then
  say "Leftovers named $PREFIX:"
  echo "$left"
  say "FAILED: the resources above are still there. Delete them by hand or run down.sh again."
  exit 1
fi
say "Leftovers named $PREFIX: none"
