#!/usr/bin/env bash
# Deploys one Warden image to Cloud Run, in three steps: migrate the database with a Cloud Run job, deploy a revision
# with the whole configuration set afresh, and wait for its /api/health to answer 200. A release then moves all of the
# service's traffic to that revision and gives the daily Job the same image. README.md's "Owner previews" and
# "Releasing" say when each runs and what it shows.
#
# Usage: scripts/cloud-run-deploy.sh <image> preview <name>
#        scripts/cloud-run-deploy.sh <image> release
#        preview <name>: the warden-preview service, a revision tagged <name> that gets no traffic, on the
#        warden_preview database, as the preview accounts only. <name> is a Cloud Run tag: 1 to 20 lowercase letters,
#        digits and hyphens, starting with a letter and not ending in a hyphen (20 keeps the revision name short).
#        release: the warden service, a revision tagged candidate on the warden database, as the live accounts only;
#        after its health gate, 100% of traffic by revision name (the release it replaces tagged previous, for a
#        rollback), then the daily Job warden-daily-expiry's image.
# Env:   GCP_PROJECT_ID, CLOUD_SQL_CONNECTION (<project>:<region>:<instance>) and VITE_CLERK_PUBLISHABLE_KEY (public),
#        all required; GITHUB_SHA and GITHUB_RUN_NUMBER (required) and GITHUB_RUN_ATTEMPT (default 1), which GitHub
#        Actions sets, name the revision. HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound the health gate.
# Needs: gcloud signed in as an account that may deploy the mode's job and service and act as its accounts; curl; jq.
# The secret versions it pins, and what it shares with the rollback, are in scripts/lib/cloud-run.sh.
set -euo pipefail

readonly PROGRAM=cloud-run-deploy
readonly USAGE="usage: scripts/cloud-run-deploy.sh <image> preview <name> | <image> release"
readonly NAME_RULE="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"
# shellcheck source-path=SCRIPTDIR source=lib/cloud-run.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/cloud-run.sh"

# One table of names per mode: the service and its account, the migration job and its account, the database, its
# role set and roles, the two password secrets, the revision suffix's start, and which of the service's URLs a Clerk
# session token may be made for (PARTIES_FROM: the tag's, for a preview reached only there; the service's own, for a
# release that takes the traffic).
names_for() {
  case $1 in
    preview)
      SERVICE=warden-preview
      RUN_ACCOUNT=warden-preview-run
      JOB=warden-migrate-preview
      MIGRATE_ACCOUNT=warden-preview-migrate
      DATABASE=warden_preview
      DATABASE_ROLES=preview
      APP_USER=warden_preview_app
      MIGRATE_USER=warden_preview_migrate
      APP_PASSWORD_SECRET=warden-db-preview-app-password
      MIGRATE_PASSWORD_SECRET=warden-db-preview-migrate-password
      SUFFIX_START=pre-$TAG
      PARTIES_FROM=tagged
      ;;
    release)
      SERVICE=warden
      RUN_ACCOUNT=warden-run
      JOB=warden-migrate
      MIGRATE_ACCOUNT=warden-migrate
      DATABASE=warden
      DATABASE_ROLES=live
      APP_USER=warden_app
      MIGRATE_USER=warden_migrate
      APP_PASSWORD_SECRET=warden-db-app-password
      MIGRATE_PASSWORD_SECRET=warden-db-migrate-password
      SUFFIX_START=rel
      PARTIES_FROM=service
      ;;
  esac
}
readonly CLERK_SECRET=warden-clerk-secret
readonly CLERK_JWT_SECRET=warden-clerk-jwt-key

migrate() {
  local password
  password=$(pinned "$MIGRATE_PASSWORD_SECRET") || exit 1
  gcloud run jobs deploy "$JOB" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$MIGRATE_ACCOUNT@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --command=node \
    --args=server/src/migrate.ts \
    --max-retries=0 \
    --set-env-vars="$(dict "PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" "WARDEN_DATABASE_ROLES=$DATABASE_ROLES" \
      "PGUSER=$MIGRATE_USER" "PGDATABASE=$DATABASE")" \
    --set-secrets="$(dict "PGPASSWORD=$password")" \
    --project="$GCP_PROJECT_ID"
  gcloud run jobs execute "$JOB" --region="$REGION" --wait --project="$GCP_PROJECT_ID" ||
    fail "the migration job $JOB failed; no revision was deployed"
}

deploy_revision() {
  local parties=$1 password clerk_secret clerk_jwt
  password=$(pinned "$APP_PASSWORD_SECRET") || exit 1
  clerk_secret=$(pinned "$CLERK_SECRET") || exit 1
  clerk_jwt=$(pinned "$CLERK_JWT_SECRET") || exit 1
  gcloud run deploy "$SERVICE" \
    --image="$IMAGE" \
    --region="$REGION" \
    --no-traffic \
    --tag="$TAG" \
    --revision-suffix="$SUFFIX" \
    --service-account="$RUN_ACCOUNT@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --set-env-vars="$(dict "PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" "PGUSER=$APP_USER" "PGDATABASE=$DATABASE" \
      "VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY" "CLERK_AUTHORIZED_PARTIES=$parties")" \
    --set-secrets="$(dict "PGPASSWORD=$password" "CLERK_SECRET_KEY=$clerk_secret" "CLERK_JWT_KEY=$clerk_jwt")" \
    --project="$GCP_PROJECT_ID"
}

# Release only: 100% of the service's traffic to the new revision, by its name (never --to-latest, which would follow
# whatever revision is newest). <serving>, the revision that had the traffic, is tagged previous in the same call when
# it's a release, so only a revision that served is ever a rollback's default target. Tags move no traffic.
move_traffic() {
  local tags=()
  [[ $1 == "$RELEASE_PREFIX"* ]] && tags=(--update-tags="previous=$1")
  gcloud run services update-traffic "$SERVICE" \
    --to-revisions="$SERVICE-$SUFFIX=100" \
    ${tags[@]+"${tags[@]}"} \
    --region="$REGION" \
    --project="$GCP_PROJECT_ID"
}

main() {
  [[ $# -ge 2 && -n $1 ]] || usage_error "give an image and a mode"
  IMAGE=$1
  local mode=$2
  case $mode in
    preview)
      [[ $# -eq 3 ]] || usage_error "preview takes one name"
      TAG=$3
      [[ $TAG =~ ^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$ ]] ||
        usage_error "the preview name '$TAG' must be $NAME_RULE"
      ;;
    release)
      [[ $# -eq 2 ]] || usage_error "release takes no name"
      TAG=candidate
      ;;
    *) usage_error "the mode must be preview or release, not '$mode'" ;;
  esac
  local var
  for var in GCP_PROJECT_ID CLOUD_SQL_CONNECTION VITE_CLERK_PUBLISHABLE_KEY GITHUB_SHA GITHUB_RUN_NUMBER; do
    [[ -n ${!var:-} ]] || usage_error "set $var"
  done
  names_for "$mode"
  SUFFIX="$SUFFIX_START-${GITHUB_SHA:0:7}-$GITHUB_RUN_NUMBER-${GITHUB_RUN_ATTEMPT:-1}"

  # The service's URLs and serving revision, read before the deploy: the revision's CLERK_AUTHORIZED_PARTIES must
  # name the URLs it's reached at.
  local described service=() tagged=() url
  described=$(describe_service "$SERVICE") || fail "couldn't read $SERVICE's URLs"
  while IFS= read -r url; do
    if [[ -n $url ]]; then
      service+=("$url")
      tagged+=("$(tag_url "$TAG" "$url")")
    fi
  done < <(service_urls "$described")
  [[ ${#service[@]} -gt 0 ]] || fail "$SERVICE reports no URL"
  local parties
  parties=$(
    IFS=,
    list="${PARTIES_FROM}[*]"
    echo "${!list}"
  )

  migrate
  deploy_revision "$parties"
  wait_for_health "${tagged[0]}" || fail "the revision gets no traffic"

  if [[ $mode == preview ]]; then
    say "Preview \`$TAG\` is up, with no traffic: ${tagged[0]}"
    return 0
  fi
  move_traffic "$(serving_revision "$described")"
  update_daily_job "$IMAGE" ||
    fail "traffic moved to $SERVICE-$SUFFIX, but updating the daily Job $DAILY_JOB failed; it still runs the previous image. Dispatch the release again, or set it by hand (README.md, Releasing)"
  say "Released \`$SERVICE-$SUFFIX\`: it has 100% of traffic at ${service[0]}, and $DAILY_JOB runs its image."
}

main "$@"
