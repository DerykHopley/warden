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
#        after its health gate, 100% of traffic by revision name, then the daily Job warden-daily-expiry's image.
# Env:   GCP_PROJECT_ID, CLOUD_SQL_CONNECTION (<project>:<region>:<instance>) and VITE_CLERK_PUBLISHABLE_KEY (public),
#        all required; GITHUB_SHA and GITHUB_RUN_NUMBER (required) and GITHUB_RUN_ATTEMPT (default 1), which GitHub
#        Actions sets, name the revision. HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound the health gate.
# Needs: gcloud signed in as an account that may deploy the mode's job and service and act as its accounts; curl; jq.
#
# Every secret is a reference to a pinned version (secret_version below), never `latest` (ADR 0009): a new version
# reaches a revision only through a PR that moves its number here.
set -euo pipefail

readonly REGION=europe-west1
readonly USAGE="usage: scripts/cloud-run-deploy.sh <image> preview <name> | <image> release"
readonly NAME_RULE="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"
readonly DAILY_JOB=warden-daily-expiry
readonly DAILY_ACCOUNT=warden-daily
readonly ADMIN_PASSWORD_SECRET=warden-db-admin-password

# Secret Manager versions the deploys read, one per secret: the only place a version number lives. gcp-setup.sh makes
# each generated password as version 1; check a hand-made secret's with `gcloud secrets versions list <secret>`.
secret_version() {
  case $1 in
    warden-db-app-password) echo 1 ;;
    warden-db-migrate-password) echo 1 ;;
    warden-db-admin-password) echo 1 ;;
    warden-db-preview-app-password) echo 1 ;;
    warden-db-preview-migrate-password) echo 1 ;;
    warden-clerk-secret) echo 1 ;;
    warden-clerk-jwt-key) echo 1 ;;
    *)
      echo "cloud-run-deploy: no pinned version for the secret $1" >&2
      exit 1
      ;;
  esac
}

# One table of names per mode: the service and its account, the migration job and its account, the database, its
# role set and roles, and the two password secrets.
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
      ;;
  esac
}
readonly CLERK_SECRET=warden-clerk-secret
readonly CLERK_JWT_SECRET=warden-clerk-jwt-key

usage_error() {
  echo "cloud-run-deploy: $1" >&2
  echo "$USAGE" >&2
  exit 1
}

# <secret>: its pinned reference, <secret>:<version>; fails, naming it, for a secret with no pinned version. Called
# in a command substitution, so each caller adds `|| exit 1`: an exit in there ends only the subshell.
pinned() {
  local version
  version=$(secret_version "$1") || return 1
  echo "$1:$version"
}

# <items...>: a gcloud dict flag's value with @ as its delimiter (`gcloud topic escaping`), so a value may hold
# commas. No value here holds an @.
dict() {
  local IFS=@
  echo "^@^$*"
}

# The service's URLs, one per line: status.url first, then any other the run.googleapis.com/urls annotation lists.
# A URL that is missing (jq's null) or empty is left out, so a service with none prints nothing.
service_urls() {
  gcloud run services describe "$SERVICE" --region="$REGION" --project="$GCP_PROJECT_ID" --format=json |
    jq -r '[.status.url] + (.metadata.annotations["run.googleapis.com/urls"] // "[]" | fromjson) | .[] | strings' |
    awk 'NF && $0 != "null" && !seen[$0]++'
}

# <url>: the URL with the tag before its host, as Cloud Run gives a tagged revision: https://<tag>---<host>.
tag_url() { echo "https://$TAG---${1#https://}"; }

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
  if ! gcloud run jobs execute "$JOB" --region="$REGION" --wait --project="$GCP_PROJECT_ID"; then
    echo "cloud-run-deploy: the migration job $JOB failed; no revision was deployed" >&2
    exit 1
  fi
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

# <url>: waits for <url>/api/health to answer 200, through a cold start; exits 1 when it never does.
health_gate() {
  local url=$1/api/health attempt status
  for ((attempt = 1; attempt <= ${HEALTH_ATTEMPTS:-18}; attempt++)); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
    [[ $status == 200 ]] && return 0
    echo "cloud-run-deploy: $url answered ${status:-nothing} (try $attempt)" >&2
    sleep "${HEALTH_INTERVAL:-5}"
  done
  echo "cloud-run-deploy: $url never answered 200; the revision gets no traffic either way" >&2
  exit 1
}

# Release only: 100% of the service's traffic to the new revision, by its name (never --to-latest, which would follow
# whatever revision is newest).
move_traffic() {
  gcloud run services update-traffic "$SERVICE" \
    --to-revisions="$SERVICE-$SUFFIX=100" \
    --region="$REGION" \
    --project="$GCP_PROJECT_ID"
}

# Release only: the daily Job (ADR 0009) runs the release's image, so the Job and the service run the same code. Its
# whole configuration is set afresh, as the revision's is. The Cloud Scheduler job that starts it is left alone.
update_daily_job() {
  local app_password admin_password
  app_password=$(pinned "$APP_PASSWORD_SECRET") || exit 1
  admin_password=$(pinned "$ADMIN_PASSWORD_SECRET") || exit 1
  if ! gcloud run jobs update "$DAILY_JOB" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$DAILY_ACCOUNT@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --command=node \
    --args=server/src/daily-expiry.ts \
    --max-retries=1 \
    --set-env-vars="$(dict "PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" "PGUSER=$APP_USER" "PGDATABASE=$DATABASE")" \
    --set-secrets="$(dict "PGPASSWORD=$app_password" "WARDEN_ADMIN_PASSWORD=$admin_password")" \
    --project="$GCP_PROJECT_ID"; then
    echo "cloud-run-deploy: traffic moved to $SERVICE-$SUFFIX, but updating the daily Job $DAILY_JOB failed;" \
      "it still runs the previous image. Dispatch the release again, or set it by hand (README.md, Releasing)" >&2
    exit 1
  fi
}

# <line>: printed, and added to the run's summary page when there is one.
say() {
  echo "$1"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
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
  if [[ $mode == preview ]]; then
    SUFFIX="pre-$TAG-${GITHUB_SHA:0:7}-$GITHUB_RUN_NUMBER-${GITHUB_RUN_ATTEMPT:-1}"
  else
    SUFFIX="rel-${GITHUB_SHA:0:7}-$GITHUB_RUN_NUMBER"
  fi

  # The service's URLs, read before the deploy: the revision's CLERK_AUTHORIZED_PARTIES must name the ones it's
  # reached at. A preview is reached at its tag's URLs only; a release, once it has the traffic, at the service's own.
  local described service=() tagged=() url
  described=$(service_urls) || {
    echo "cloud-run-deploy: couldn't read $SERVICE's URLs" >&2
    exit 1
  }
  while IFS= read -r url; do
    if [[ -n $url ]]; then
      service+=("$url")
      tagged+=("$(tag_url "$url")")
    fi
  done <<<"$described"
  [[ ${#service[@]} -gt 0 ]] || {
    echo "cloud-run-deploy: $SERVICE reports no URL" >&2
    exit 1
  }
  local parties
  if [[ $mode == preview ]]; then
    parties=$(
      IFS=,
      echo "${tagged[*]}"
    )
  else
    parties=$(
      IFS=,
      echo "${service[*]}"
    )
  fi

  migrate
  deploy_revision "$parties"
  health_gate "${tagged[0]}"

  if [[ $mode == preview ]]; then
    say "Preview \`$TAG\` is up, with no traffic: ${tagged[0]}"
    return 0
  fi
  move_traffic
  update_daily_job
  say "Released \`$SERVICE-$SUFFIX\`: it has 100% of traffic at ${service[0]}, and $DAILY_JOB runs its image."
}

main "$@"
