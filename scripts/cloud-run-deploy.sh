#!/usr/bin/env bash
# Deploys one Warden image to Cloud Run, in three steps: migrate the database with a Cloud Run job, deploy a revision
# with the whole configuration set afresh, and wait for its /api/health to answer 200. README.md's "Owner previews"
# says when it runs and what it shows.
#
# Usage: scripts/cloud-run-deploy.sh <image> preview <name>
#        preview <name>: the warden-preview service, a revision tagged <name> that gets no traffic, on the
#        warden_preview database, as the preview accounts only. <name> is a Cloud Run tag: 1 to 20 lowercase letters,
#        digits and hyphens, starting with a letter and not ending in a hyphen (20 keeps the revision name short).
#        A release mode is #24's, beside preview in names_for.
# Env:   GCP_PROJECT_ID, CLOUD_SQL_CONNECTION (<project>:<region>:<instance>) and VITE_CLERK_PUBLISHABLE_KEY (public),
#        all required; GITHUB_SHA and GITHUB_RUN_NUMBER (required) and GITHUB_RUN_ATTEMPT (default 1), which GitHub
#        Actions sets, name the revision. HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound the health gate.
# Needs: gcloud signed in as an account that may deploy the mode's job and service and act as its accounts; curl; jq.
#
# Every secret is a reference to a pinned version (SECRET_VERSIONS below), never `latest` (ADR 0009): a new version
# reaches a revision only through a PR that moves its number here.
set -euo pipefail

readonly REGION=europe-west1
readonly USAGE="usage: scripts/cloud-run-deploy.sh <image> preview <name>"
readonly NAME_RULE="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"

# Secret Manager versions the deploys read, one per secret: the only place a version number lives. gcp-setup.sh makes
# each generated password as version 1; check a hand-made secret's with `gcloud secrets versions list <secret>`.
secret_version() {
  case $1 in
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
service_urls() {
  gcloud run services describe "$SERVICE" --region="$REGION" --project="$GCP_PROJECT_ID" --format=json |
    jq -r '[.status.url] + (.metadata.annotations["run.googleapis.com/urls"] // "[]" | fromjson) | .[]' |
    awk 'NF && !seen[$0]++'
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

main() {
  [[ $# -ge 2 && -n $1 ]] || usage_error "give an image and a mode"
  IMAGE=$1
  case $2 in
    preview)
      [[ $# -eq 3 ]] || usage_error "preview takes one name"
      TAG=$3
      [[ $TAG =~ ^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$ ]] ||
        usage_error "the preview name '$TAG' must be $NAME_RULE"
      ;;
    *) usage_error "the mode must be preview, not '$2'" ;;
  esac
  local var
  for var in GCP_PROJECT_ID CLOUD_SQL_CONNECTION VITE_CLERK_PUBLISHABLE_KEY GITHUB_SHA GITHUB_RUN_NUMBER; do
    [[ -n ${!var:-} ]] || usage_error "set $var"
  done
  names_for "$2"
  SUFFIX="pre-$TAG-${GITHUB_SHA:0:7}-$GITHUB_RUN_NUMBER-${GITHUB_RUN_ATTEMPT:-1}"

  # The tag's URLs, read before the deploy: the revision's CLERK_AUTHORIZED_PARTIES must name them.
  local described urls=() url
  described=$(service_urls) || {
    echo "cloud-run-deploy: couldn't read $SERVICE's URLs" >&2
    exit 1
  }
  while IFS= read -r url; do
    [[ -n $url ]] && urls+=("$(tag_url "$url")")
  done <<<"$described"
  [[ ${#urls[@]} -gt 0 ]] || {
    echo "cloud-run-deploy: $SERVICE reports no URL" >&2
    exit 1
  }
  local parties
  parties=$(
    IFS=,
    echo "${urls[*]}"
  )

  migrate
  deploy_revision "$parties"
  health_gate "${urls[0]}"

  echo "Preview $TAG is up, with no traffic: ${urls[0]}"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    echo "Preview \`$TAG\` is up, with no traffic: ${urls[0]}" >>"$GITHUB_STEP_SUMMARY"
  fi
}

main "$@"
