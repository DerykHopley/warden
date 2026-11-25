#!/usr/bin/env bash
# Rolls the live service back to an earlier revision. It never moves traffic to a revision that hasn't answered:
#   1. tag the revision rollback, and wait for https://rollback---<host>/api/health to answer 200 (no traffic moves);
#   2. read the serving revision again, and stop if a release moved the traffic meanwhile; otherwise move 100% of
#      warden's traffic to it by name;
#   3. give the daily Job warden-daily-expiry that revision's image, by digest, with the Job's whole configuration set
#      afresh as a release sets it (scripts/lib/cloud-run.sh), then the Scan Job warden-scan the same, with the GitHub
#      app's client id and private key, so the Jobs and the service run the same code;
#   4. check that the service's own /api/health answers 200.
# README.md's "Releasing" says when to use it.
#
# Usage: scripts/cloud-run-rollback.sh [revision]
#        With a revision: that one, which must be one of warden's release revisions (warden-rel-…), never Google's
#        placeholder.
#        With none: the release revision tagged previous, which a release tags when it takes the traffic from it, so
#        only a revision that served is chosen. A newer revision whose health gate failed never gets that tag.
# Env:   GCP_PROJECT_ID, CLOUD_SQL_CONNECTION (<project>:<region>:<instance>) and WARDEN_GITHUB_APP_CLIENT_ID (the
#        read-only GitHub app's client id, public, for the Scan Job), required. ROLLBACK_FROM, optional:
#        the revision the caller saw serving; when another serves now, it stops before changing anything.
#        HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound each health check.
# Needs: gcloud signed in as an account that may change warden's traffic and update the daily Job and the Scan Job;
#        curl; jq.
#
# Migrations only run forwards: the database keeps the newer schema, which the earlier code must still work with.
set -euo pipefail

readonly PROGRAM=cloud-run-rollback
readonly USAGE="usage: [ROLLBACK_FROM=<revision>] scripts/cloud-run-rollback.sh [revision]"
readonly SERVICE=warden
readonly REVISION_NAME='^[a-z]([a-z0-9-]*[a-z0-9])?$'
# shellcheck source-path=SCRIPTDIR source=lib/cloud-run.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/cloud-run.sh"

main() {
  [[ $# -le 1 ]] || usage_error "give at most one revision"
  local target=${1-} from=${ROLLBACK_FROM:-}
  [[ -z $target || $target =~ $REVISION_NAME ]] || usage_error "'$target' isn't a revision name"
  # Google's placeholder (warden-00001-…) answers 200 on any path, so the health checks would pass, but its image
  # can't run the daily Job: a rollback goes only to a revision a release made.
  [[ -z $target || $target == "$RELEASE_PREFIX"* ]] ||
    usage_error "'$target' isn't a release: a rollback goes only to a release revision (${RELEASE_PREFIX}…); nothing changed"
  [[ -z $from || $from =~ $REVISION_NAME ]] || usage_error "ROLLBACK_FROM '$from' isn't a revision name"
  local var
  for var in GCP_PROJECT_ID CLOUD_SQL_CONNECTION WARDEN_GITHUB_APP_CLIENT_ID; do
    [[ -n ${!var:-} ]] || usage_error "set $var"
  done

  local described url serving
  described=$(describe_service "$SERVICE") || fail "couldn't read $SERVICE"
  url=$(jq -r '.status.url // empty' <<<"$described")
  [[ -n $url ]] || fail "$SERVICE reports no URL"
  serving=$(serving_revision "$described")
  if [[ -n $from && $from != "$serving" ]]; then
    fail "$SERVICE's serving revision changed since the rollback was asked for (${serving:-a split}, not $from); nothing changed"
  fi

  if [[ -z $target ]]; then
    [[ -n $serving ]] || fail "no one revision has all of $SERVICE's traffic; name the revision to roll back to"
    target=$(jq -r '[.status.traffic[]? | select(.tag == "previous") | .revisionName] | first // empty' \
      <<<"$described")
    [[ $target == "$RELEASE_PREFIX"* ]] ||
      fail "no release is tagged previous; traffic is unchanged. Name the revision to roll back to"
    [[ $target != "$serving" ]] ||
      fail "$target, the release tagged previous, is already serving; traffic is unchanged. Name the revision to roll back to"
  fi

  local revisions digest
  revisions=$(gcloud run revisions list --service="$SERVICE" --region="$REGION" --project="$GCP_PROJECT_ID" \
    --format=json) || fail "couldn't list $SERVICE's revisions"
  digest=$(jq -r --arg name "$target" 'map(select(.metadata.name == $name)) | first | .status.imageDigest // empty' \
    <<<"$revisions")
  [[ -n $digest ]] || fail "$target isn't one of $SERVICE's revisions, or has no image digest; traffic is unchanged"

  echo "Rolling $SERVICE back from ${serving:-a split} to $target ($digest)"
  gcloud run services update-traffic "$SERVICE" --update-tags="rollback=$target" --region="$REGION" \
    --project="$GCP_PROJECT_ID"
  wait_for_health "$(tag_url rollback "$url")" || fail "$target didn't answer on its rollback tag; traffic is unchanged"
  # A release runs beside a rollback (each has its own lock), so the serving revision is read again just before the
  # traffic moves: if a release moved it meanwhile, the rollback stops rather than undo that release unseen.
  local now
  now=$(serving_revision "$(describe_service "$SERVICE")") || fail "couldn't read $SERVICE again; traffic is unchanged"
  [[ $now == "$serving" ]] ||
    fail "$SERVICE's serving revision changed while $target was checked (${now:-a split} now, not ${serving:-a split}); traffic is unchanged. Dispatch the rollback again if it's still wanted"
  gcloud run services update-traffic "$SERVICE" --to-revisions="$target=100" --region="$REGION" \
    --project="$GCP_PROJECT_ID"
  update_daily_job "$digest" ||
    fail "traffic moved to $target, but updating the daily Job $DAILY_JOB failed; it still runs the newer image"
  update_scan_job "$digest" ||
    fail "traffic and $DAILY_JOB moved to $target, but updating the Scan Job $SCAN_JOB failed; it still runs the newer image"
  wait_for_health "$url" ||
    fail "after the rollback, $url never answered 200; traffic and the Jobs have moved, so check $target's logs"

  say "Rolled back: $target has 100% of $SERVICE's traffic at $url, and $DAILY_JOB and $SCAN_JOB run its image."
}

main "$@"
