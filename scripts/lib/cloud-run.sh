# shellcheck shell=bash
# What the Cloud Run deploy and rollback scripts share: the region, the daily Job and the Scan Job and how each is
# configured, the pinned secret versions, the service's URLs and serving revision, and the health check. Sourced,
# never run; the script sets PROGRAM (its name, for messages) and USAGE first, GCP_PROJECT_ID and
# CLOUD_SQL_CONNECTION before calling anything that reaches gcloud, and WARDEN_GITHUB_APP_CLIENT_ID before
# update_scan_job.
#
# Every secret is a reference to a pinned version (secret_version below), never `latest` (ADR 0009): a new version
# reaches a revision or a job only through a PR that moves its number here.

readonly REGION=europe-west1
# shellcheck disable=SC2034 # read by the scripts that source this
readonly RELEASE_PREFIX=warden-rel-
readonly DAILY_JOB=warden-daily-expiry
readonly DAILY_ACCOUNT=warden-daily
# The Scan Job (ADR 0009): the service starts one execution per Scan, naming it by WARDEN_SCAN_JOB.
readonly SCAN_JOB=warden-scan
readonly SCAN_ACCOUNT=warden-scan

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
    warden-github-app-client-secret) echo 1 ;;
    warden-github-app-private-key) echo 1 ;;
    *)
      echo "$PROGRAM: no pinned version for the secret $1" >&2
      exit 1
      ;;
  esac
}

# <message>: the message and the usage line, then exit 1.
usage_error() {
  echo "$PROGRAM: $1" >&2
  echo "$USAGE" >&2
  exit 1
}

# <message>: the message, then exit 1.
fail() {
  echo "$PROGRAM: $1" >&2
  exit 1
}

# <line>: printed, and added to the run's summary page when there is one.
say() {
  echo "$1"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
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

# <service>: its description, as JSON.
describe_service() {
  gcloud run services describe "$1" --region="$REGION" --project="$GCP_PROJECT_ID" --format=json
}

# <description>: the service's URLs, one per line: status.url first, then any other the run.googleapis.com/urls
# annotation lists. A missing URL (jq's null) or an empty one is left out, so a service with none prints nothing.
service_urls() {
  jq -r '[.status.url] + (.metadata.annotations["run.googleapis.com/urls"] // "[]" | fromjson) | .[] | strings' \
    <<<"$1" | awk 'NF && !seen[$0]++'
}

# <description>: the revision with all of the service's traffic, or nothing when it's split.
serving_revision() {
  jq -r '[.status.traffic[]? | select(.percent == 100) | .revisionName] | first // empty' <<<"$1"
}

# <tag> <url>: the URL with the tag before its host, as Cloud Run gives a tagged revision: https://<tag>---<host>.
tag_url() { echo "https://$1---${2#https://}"; }

# <url>: waits for <url>/api/health to answer 200, through a cold start; returns 1 when it never does.
wait_for_health() {
  local url=$1/api/health attempt status
  for ((attempt = 1; attempt <= ${HEALTH_ATTEMPTS:-18}; attempt++)); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
    [[ $status == 200 ]] && return 0
    echo "$PROGRAM: $url answered ${status:-nothing} (try $attempt)" >&2
    sleep "${HEALTH_INTERVAL:-5}"
  done
  echo "$PROGRAM: $url never answered 200" >&2
  return 1
}

# [KEY=VALUE...]: a Job's plain values, as a dict: the warden database as warden_app, then any given.
job_env() { dict "PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" PGUSER=warden_app PGDATABASE=warden "$@"; }

# <job> <image> <account> <script> <env> <secrets> [flag...]: the Job runs <image> as <account>, `node <script>`,
# with one retry, the plain values <env> (a dict, from job_env), the secrets <secrets> (a dict) and any flag given.
# Its whole configuration is set afresh from here: the same on a release and a rollback. Returns gcloud's status.
update_job() {
  local job=$1 image=$2 account=$3 script=$4 env=$5 secrets=$6
  shift 6
  gcloud run jobs update "$job" \
    --image="$image" \
    --region="$REGION" \
    --service-account="$account@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --command=node \
    --args="$script" \
    --max-retries=1 \
    "$@" \
    --set-env-vars="$env" \
    --set-secrets="$secrets" \
    --project="$GCP_PROJECT_ID"
}

# <image>: the daily Job (ADR 0009) runs that image. The Cloud Scheduler job that starts it is left alone. Returns
# gcloud's status.
update_daily_job() {
  local app_password admin_password
  app_password=$(pinned warden-db-app-password) || exit 1
  admin_password=$(pinned warden-db-admin-password) || exit 1
  update_job "$DAILY_JOB" "$1" "$DAILY_ACCOUNT" server/src/daily-expiry.ts "$(job_env)" \
    "$(dict "PGPASSWORD=$app_password" "WARDEN_ADMIN_PASSWORD=$admin_password")"
}

# The Scan Job's resource name, as the live revision's WARDEN_SCAN_JOB holds it.
scan_job_name() { echo "projects/$GCP_PROJECT_ID/locations/$REGION/jobs/$SCAN_JOB"; }

# <image>: the Scan Job (ADR 0009) runs that image, for up to an hour a task. Each execution's override holds only a
# Scan id and a Team; the Job works inside that Team, as warden_app, so it gets the app password, never the admin
# password or a Clerk key. It reads the Team's repos as the GitHub app (#168): the client id
# (WARDEN_GITHUB_APP_CLIENT_ID, which each caller requires) and the private key, never the client secret, so it can't
# sign anyone in to GitHub. Returns gcloud's status.
update_scan_job() {
  # Read here, not inside the $(...) below, so an unset one stops the script (set -u) rather than only the subshell.
  local client_id=$WARDEN_GITHUB_APP_CLIENT_ID app_password github_key
  app_password=$(pinned warden-db-app-password) || exit 1
  github_key=$(pinned warden-github-app-private-key) || exit 1
  update_job "$SCAN_JOB" "$1" "$SCAN_ACCOUNT" server/src/scan-job.ts "$(job_env "GITHUB_APP_CLIENT_ID=$client_id")" \
    "$(dict "PGPASSWORD=$app_password" "GITHUB_APP_PRIVATE_KEY=$github_key")" \
    --task-timeout=3600s
}
