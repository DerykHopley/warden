#!/usr/bin/env bash
# Rolls the live service back to an earlier revision: 100% of warden's traffic to it by name, then the daily Job
# warden-daily-expiry onto that revision's image (so the Job and the service run the same code), then a check that
# the service's /api/health answers 200. README.md's "Releasing" says when to use it.
#
# Usage: scripts/cloud-run-rollback.sh [revision]
#        With a revision: that one, which must be one of warden's revisions.
#        With none: the newest release revision (warden-rel-…) made before the one that has all the traffic now.
# Env:   GCP_PROJECT_ID, required. HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound the health check.
# Needs: gcloud signed in as an account that may change warden's traffic and update the daily Job; curl; jq.
#
# Migrations only run forwards: the database keeps the newer schema, which the earlier code must still work with.
set -euo pipefail

readonly REGION=europe-west1
readonly SERVICE=warden
readonly DAILY_JOB=warden-daily-expiry
readonly RELEASE_PREFIX=warden-rel-
readonly USAGE="usage: scripts/cloud-run-rollback.sh [revision]"

usage_error() {
  echo "cloud-run-rollback: $1" >&2
  echo "$USAGE" >&2
  exit 1
}

fail() {
  echo "cloud-run-rollback: $1" >&2
  exit 1
}

# <revisions json> <serving revision>: the newest release revision created before the serving one, or nothing.
# Cloud Run writes creationTimestamp with or without fractional seconds, so they're dropped before comparing.
previous_release() {
  jq -r --arg serving "$2" --arg prefix "$RELEASE_PREFIX" '
    def created: .metadata.creationTimestamp | sub("\\.[0-9]+"; "") | fromdateiso8601;
    (map(select(.metadata.name == $serving)) | first) as $now
    | if $now == null then empty else
        map(select((.metadata.name | startswith($prefix)) and created < ($now | created)))
        | sort_by(created) | last | .metadata.name // empty
      end' <<<"$1"
}

# <url>: waits for <url>/api/health to answer 200, through a cold start; exits 1 when it never does.
health_check() {
  local url=$1/api/health attempt status
  for ((attempt = 1; attempt <= ${HEALTH_ATTEMPTS:-18}; attempt++)); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
    [[ $status == 200 ]] && return 0
    echo "cloud-run-rollback: $url answered ${status:-nothing} (try $attempt)" >&2
    sleep "${HEALTH_INTERVAL:-5}"
  done
  fail "$url never answered 200 after the rollback; traffic and the daily Job have moved, so check the revision's logs"
}

main() {
  [[ $# -le 1 ]] || usage_error "give at most one revision"
  local target=${1-}
  if [[ -n $target ]]; then
    [[ $target =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]] || usage_error "'$target' isn't a revision name"
  fi
  [[ -n ${GCP_PROJECT_ID:-} ]] || usage_error "set GCP_PROJECT_ID"

  local described revisions url serving
  described=$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$GCP_PROJECT_ID" \
    --format=json) || fail "couldn't read $SERVICE"
  url=$(jq -r '.status.url // empty' <<<"$described")
  [[ -n $url ]] || fail "$SERVICE reports no URL"
  serving=$(jq -r '[.status.traffic[]? | select(.percent == 100) | .revisionName] | first // empty' <<<"$described")
  revisions=$(gcloud run revisions list --service="$SERVICE" --region="$REGION" --project="$GCP_PROJECT_ID" \
    --format=json) || fail "couldn't list $SERVICE's revisions"

  if [[ -z $target ]]; then
    [[ -n $serving ]] || fail "no one revision has all of $SERVICE's traffic; name the revision to roll back to"
    target=$(previous_release "$revisions" "$serving")
    [[ -n $target ]] || fail "no release revision older than $serving; traffic is unchanged"
  fi
  local image
  image=$(jq -r --arg name "$target" 'map(select(.metadata.name == $name)) | first | .spec.containers[0].image // empty' \
    <<<"$revisions")
  [[ -n $image ]] || fail "$target isn't one of $SERVICE's revisions; traffic is unchanged"

  echo "Rolling $SERVICE back from ${serving:-a split} to $target ($image)"
  gcloud run services update-traffic "$SERVICE" --to-revisions="$target=100" --region="$REGION" \
    --project="$GCP_PROJECT_ID"
  gcloud run jobs update "$DAILY_JOB" --image="$image" --region="$REGION" --project="$GCP_PROJECT_ID" ||
    fail "traffic moved to $target, but updating the daily Job $DAILY_JOB failed; it still runs the newer image"
  health_check "$url"

  local done="Rolled back: $target has 100% of $SERVICE's traffic at $url, and $DAILY_JOB runs its image."
  echo "$done"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then echo "$done" >>"$GITHUB_STEP_SUMMARY"; fi
}

main "$@"
