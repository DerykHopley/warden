#!/usr/bin/env bash
# Sets up Warden's Google Cloud project, once: the APIs, the Docker repositories, the database's backups and network,
# log retention and Secret Manager's audit logs, one password secret per database role, the database roles
# themselves, two sets of service accounts (live, with the daily Job's, and owner previews), GitHub's deploy
# identities, the two public services, the preview migration job, and the daily expiry Job with the Cloud Scheduler
# job that starts it. Safe to run again: it creates only what's missing, and sets each setting to the value below
# whatever it was. README.md's "Setting up Google Cloud" says what it makes, and why.
#
# Usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>
#        DRY_RUN=1 prints each command instead of running it, needs no credentials, and assumes nothing exists yet.
#        Unset, empty or 0 is a real run. Any other value stops it before anything runs.
# Env:   WARDEN_GITHUB_REPO (<owner>/<repo>) and WARDEN_GITHUB_REPO_ID (its numeric id:
#        `gh api repos/<owner>/<repo> --jq .id`), both required: the one GitHub repository that may deploy.
# Needs: for a real run, gcloud signed in, application-default credentials (gcloud auth application-default login),
#        node, cloud-sql-proxy, and the server's dependencies (pnpm install): the roles step runs
#        server/src/roles.ts from this machine.
#
# No secret value is printed, logged or written to a file: each password is generated in a pipe straight into
# `gcloud secrets create --data-file=-`, and read back only into the one roles process's environment.
set -euo pipefail

readonly REGION=europe-west1
readonly REPOSITORY=warden
readonly SERVICE=warden
readonly PREVIEW_REPOSITORY=warden-preview
readonly PREVIEW_SERVICE=warden-preview
readonly PREVIEW_JOB=warden-migrate-preview
# The daily expiry Job and the Cloud Scheduler job that starts it share this name (ADR 0009). After the 03:00 backup.
readonly DAILY_JOB=warden-daily-expiry
readonly DAILY_SCHEDULE="0 4 * * *"
readonly SERVICE_IMAGE=us-docker.pkg.dev/cloudrun/container/hello
readonly JOB_IMAGE=us-docker.pkg.dev/cloudrun/container/job:latest
readonly POOL=github
readonly PROVIDER=warden
readonly SECRET_READS_SERVICE=secretmanager.googleapis.com
# Cloud SQL's docs: "the transaction log retention setting must be less than the backup retention setting".
readonly BACKUPS=7
readonly LOG_DAYS=6
# The database passwords the script generates: each set's app and migration roles, and the live admin role's, which
# only the daily Job reads. (Assigned, then made readonly: the form bash 3.2 accepts.)
GENERATED_SECRETS=(warden-db-app-password warden-db-migrate-password warden-db-preview-app-password
  warden-db-preview-migrate-password warden-db-admin-password)
readonly GENERATED_SECRETS
# The repository this script is in: the roles step runs its server/src/roles.ts.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly ROOT

# What the EXIT trap cleans up: the audit-policy file and the Cloud SQL Auth Proxy, when there are any.
POLICY_FILE=""
PROXY_PID=""
PROXY_PORT=""

cleanup() {
  if [[ -n $PROXY_PID ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
  fi
  if [[ -n $POLICY_FILE ]]; then rm -f "$POLICY_FILE"; fi
}

# DRY_RUN fails closed: only 1 is a dry run, and a value it doesn't know (true, yes) stops the script rather than
# running for real.
check_dry_run() {
  case ${DRY_RUN-} in
    "" | 0 | 1) ;;
    *)
      echo "gcp-setup: DRY_RUN must be 1 (a dry run) or 0 (a real run, as when it's unset or empty)," \
        "not '$DRY_RUN'" >&2
      exit 1
      ;;
  esac
}

dry_run() { [[ ${DRY_RUN-} == 1 ]]; }

# A command as it would be typed: arguments with anything but safe characters single-quoted.
print_command() {
  local out="" arg
  for arg in "$@"; do
    if [[ $arg =~ ^[A-Za-z0-9_./:=@,+-]+$ ]]; then
      out+=" $arg"
    else
      out+=" '${arg//\'/\'\\\'\'}'"
    fi
  done
  printf '%s\n' "${out# }"
}

# Runs a command that changes something, or prints it in a dry run.
run() {
  if dry_run; then print_command "$@"; else "$@"; fi
}

# A binding made right after its service account (or service, or job) can fail until it's visible everywhere: tried
# 5 times.
run_retrying() {
  if dry_run; then
    print_command "$@"
    return
  fi
  local try
  for try in 1 2 3 4 5; do
    "$@" --format=none && return
    [[ $try == 5 ]] && return 1
    echo "  retrying in 10s ($try of 5)" >&2
    sleep 10
  done
}

# How each describe command this script runs says it found nothing: NOT_FOUND from most APIs, a bare 404 from
# Cloud SQL's databases, Cloud Run's own messages, and Cloud SQL's for an instance (which it also gives when you may
# not see the instance).
readonly NOT_FOUND='NOT_FOUND|HTTPError 404|Cannot find service \[|Cannot find job \[|There was no instance found at '

# Whether a describe command finds its resource. Found nothing: false. Any other failure (no permission, a network
# error) stops the script, printing gcloud's error, as the resource's absence isn't known. A dry run assumes
# nothing exists.
exists() {
  if dry_run; then return 1; fi
  local error
  if error=$("$@" 2>&1 >/dev/null); then return 0; fi
  if [[ $error =~ $NOT_FOUND ]]; then return 1; fi
  printf 'gcp-setup: %s failed:\n%s\n' "$(print_command "$@")" "$error" >&2
  exit 1
}

# A value read from Google, or the placeholder a dry run prints in its place.
query() {
  local placeholder=$1
  shift
  if dry_run; then printf '%s' "$placeholder"; else "$@"; fi
}

note() { printf '# %s\n' "$*"; }
step() { printf '\n# == %s\n' "$*"; }

# 32 random bytes as 64 hex characters: printable ASCII, as createRoles requires.
random_password() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# Reads a project IAM policy (JSON) and prints it with Secret Manager's DATA_READ audit log on: every other part of
# the policy (bindings, etag, other services' audit configs) is kept as it is.
with_secret_reads_logged() {
  SERVICE_NAME=$SECRET_READS_SERVICE node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const policy = JSON.parse(input);
    const service = process.env.SERVICE_NAME;
    policy.auditConfigs ??= [];
    let config = policy.auditConfigs.find((c) => c.service === service);
    if (!config) policy.auditConfigs.push((config = { service, auditLogConfigs: [] }));
    config.auditLogConfigs ??= [];
    if (!config.auditLogConfigs.some((c) => c.logType === "DATA_READ")) {
      config.auditLogConfigs.push({ logType: "DATA_READ" });
    }
    process.stdout.write(JSON.stringify(policy));
  '
}

# The one GitHub repository that may deploy, from WARDEN_GITHUB_REPO and WARDEN_GITHUB_REPO_ID: both required, with
# no default, so a fork can't set up a project that trusts another repository by mistake.
github_repository() {
  if [[ -z "${WARDEN_GITHUB_REPO:-}" || -z "${WARDEN_GITHUB_REPO_ID:-}" ]]; then
    echo "gcp-setup: set WARDEN_GITHUB_REPO (<owner>/<repo>) and WARDEN_GITHUB_REPO_ID" \
      "(gh api repos/<owner>/<repo> --jq .id): the GitHub repository that may deploy" >&2
    exit 1
  fi
  if [[ ! $WARDEN_GITHUB_REPO_ID =~ ^[0-9]+$ ]]; then
    echo "gcp-setup: WARDEN_GITHUB_REPO_ID must be the repository's numeric id, not '$WARDEN_GITHUB_REPO_ID'" >&2
    exit 1
  fi
  if [[ ! $WARDEN_GITHUB_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "gcp-setup: WARDEN_GITHUB_REPO must be <owner>/<repo>, not '$WARDEN_GITHUB_REPO'" >&2
    exit 1
  fi
  GITHUB_REPO=$WARDEN_GITHUB_REPO
  GITHUB_REPO_ID=$WARDEN_GITHUB_REPO_ID
}

preflight() {
  if dry_run; then
    note "DRY_RUN: printing the commands only, as if nothing existed yet; a real run skips what's already there"
    return
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcp-setup: gcloud isn't on PATH; install the Google Cloud CLI first" >&2
    exit 1
  fi
  if [[ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]]; then
    echo "gcp-setup: gcloud isn't signed in; run gcloud auth login first" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "gcp-setup: node isn't on PATH; it edits the project's audit-log policy and runs the roles step" >&2
    exit 1
  fi
  # The roles step: the proxy, the roles script's dependencies, and the credentials the proxy connects with.
  if ! command -v cloud-sql-proxy >/dev/null 2>&1; then
    echo "gcp-setup: cloud-sql-proxy isn't on PATH; install the Cloud SQL Auth Proxy first" \
      "(gcloud components install cloud-sql-proxy, or" \
      "https://cloud.google.com/sql/docs/postgres/sql-proxy#install): the roles step connects through it" >&2
    exit 1
  fi
  if [[ ! -d $ROOT/server/node_modules/pg ]]; then
    echo "gcp-setup: the server's dependencies aren't installed; run pnpm install first:" \
      "the roles step runs server/src/roles.ts" >&2
    exit 1
  fi
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    echo "gcp-setup: no application-default credentials for the Cloud SQL Auth Proxy;" \
      "run gcloud auth application-default login first" >&2
    exit 1
  fi
  # What the owner makes by hand, checked before any change.
  local project=$1 instance=$2 missing=() secret
  exists gcloud sql instances describe "$instance" --project="$project" ||
    missing+=("Cloud SQL instance $instance")
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key; do
    exists gcloud secrets describe "$secret" --project="$project" || missing+=("secret $secret")
  done
  if [[ -n ${missing[*]+set} ]]; then
    echo "gcp-setup: make these first (README.md, \"Setting up Google Cloud\"); nothing was changed:" >&2
    printf '  %s\n' ${missing[@]+"${missing[@]}"} >&2
    exit 1
  fi
}

# A free local port for the proxy: one the system hands out, then closes.
free_port() {
  node -e 'const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });'
}

# Whether the proxy this script started is still running.
proxy_running() { [[ -n $PROXY_PID ]] && kill -0 "$PROXY_PID" 2>/dev/null; }

# One try at the Cloud SQL Auth Proxy for <connection>, on a fresh free local port: 0 once it listens, 1 when it
# stopped first (on a port another process took since it was free, say; its error is above). The port is probed only
# while the proxy runs, and the proxy must still run a second after the port answers: a port that answers when the
# proxy is gone belongs to another process, which must never be sent a password.
launch_proxy() {
  local connection=$1 waited=0
  PROXY_PORT=$(free_port)
  cloud-sql-proxy --quiet --address=127.0.0.1 --port="$PROXY_PORT" "$connection" >&2 &
  PROXY_PID=$!
  while proxy_running; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null; then
      sleep 1
      if proxy_running; then return 0; fi
      break
    fi
    if [[ $waited -ge 30 ]]; then
      echo "gcp-setup: the Cloud SQL Auth Proxy wasn't listening on 127.0.0.1:$PROXY_PORT after 30s" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$PROXY_PID" 2>/dev/null || true
  PROXY_PID=""
  return 1
}

# Starts the Cloud SQL Auth Proxy for <connection> on a free local port, and waits until it listens: tried once more
# on a fresh port when it stops first. It connects with application-default credentials. The EXIT trap stops it, also
# when the script fails.
start_proxy() {
  if launch_proxy "$1"; then return 0; fi
  echo "gcp-setup: the Cloud SQL Auth Proxy stopped before it was ready; trying once more on another port" >&2
  if launch_proxy "$1"; then return 0; fi
  echo "gcp-setup: the Cloud SQL Auth Proxy stopped before it was ready; its error is above" >&2
  exit 1
}

# grant_secrets <project> <account> <secret...>: each secret readable by that account.
grant_secrets() {
  local project=$1 account=$2 secret
  shift 2
  for secret in "$@"; do
    run_retrying gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$account" \
      --role=roles/secretmanager.secretAccessor --project="$project"
  done
}

# ensure_service <project> <service> <service account> <max instances>: made with Google's placeholder image, public,
# or its settings and public access put back, keeping whatever image it runs now.
ensure_service() {
  local project=$1 service=$2 account=$3 max=$4
  if ! exists gcloud run services describe "$service" --region="$REGION" --project="$project"; then
    run gcloud run deploy "$service" --image="$SERVICE_IMAGE" --region="$REGION" --service-account="$account" \
      --allow-unauthenticated --max-instances="$max" --project="$project"
  else
    run gcloud run services update "$service" --region="$REGION" --service-account="$account" \
      --max-instances="$max" --project="$project"
    run_retrying gcloud run services add-iam-policy-binding "$service" --region="$REGION" --member=allUsers \
      --role=roles/run.invoker --project="$project"
  fi
}

# ensure_job <project> <job> <service account>: made with Google's placeholder job image, or its service account put
# back, keeping whatever image it runs now (a release sets that).
ensure_job() {
  local project=$1 job=$2 account=$3
  if ! exists gcloud run jobs describe "$job" --region="$REGION" --project="$project"; then
    run gcloud run jobs create "$job" --image="$JOB_IMAGE" --region="$REGION" --service-account="$account" \
      --project="$project"
  else
    run gcloud run jobs update "$job" --region="$REGION" --service-account="$account" --project="$project"
  fi
}

# The roles run for a set as the dry run prints it: <set> <database> <app secret> <migrate secret> [admin secret].
print_roles() {
  printf '%s\n' "WARDEN_DATABASE_ROLES=$1 PGHOST=127.0.0.1 PGPORT=LOCAL_PORT PGUSER=postgres PGDATABASE=$2" \
    "PGPASSWORD=<from warden-db-password> WARDEN_APP_PASSWORD=<from $3> WARDEN_MIGRATE_PASSWORD=<from $4>" \
    ${5:+"WARDEN_ADMIN_PASSWORD=<from $5>"} "node server/src/roles.ts" | paste -sd ' ' -
}

# run_roles <project> <set> <database> <app secret> <migrate secret> [admin secret]: the roles script for one set, on
# its own database, as postgres, through the proxy. Each password goes from Secret Manager into this one process's
# environment only (a prefix assignment, not an argument). Without an admin secret, the admin role gets no password
# (the preview set: no preview Job runs, so it can't log in). A failure stops the script with the roles script's exit
# code; its own error, which holds no password, is above.
run_roles() {
  local project=$1 set=$2 database=$3 app_secret=$4 migrate_secret=$5 admin_secret=${6-}
  local postgres_password app_password migrate_password admin_password="" status=0
  postgres_password=$(gcloud secrets versions access latest --secret=warden-db-password --project="$project")
  app_password=$(gcloud secrets versions access latest --secret="$app_secret" --project="$project")
  migrate_password=$(gcloud secrets versions access latest --secret="$migrate_secret" --project="$project")
  if [[ -n $admin_secret ]]; then
    admin_password=$(gcloud secrets versions access latest --secret="$admin_secret" --project="$project")
  fi
  note "the $set roles, on $database"
  WARDEN_DATABASE_ROLES=$set PGHOST=127.0.0.1 PGPORT=$PROXY_PORT PGUSER=postgres PGDATABASE=$database \
    PGPASSWORD=$postgres_password WARDEN_APP_PASSWORD=$app_password WARDEN_MIGRATE_PASSWORD=$migrate_password \
    WARDEN_ADMIN_PASSWORD=$admin_password node "$ROOT/server/src/roles.ts" || status=$?
  if [[ $status != 0 ]]; then
    echo "gcp-setup: the roles step failed for the $set set on $database (exit $status);" \
      "the roles script's error is above" >&2
    exit "$status"
  fi
}

main() {
  check_dry_run
  if [[ $# -ne 2 ]]; then
    echo "usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>" >&2
    exit 1
  fi
  local project=$1 instance=$2
  github_repository
  trap cleanup EXIT
  # A signal still runs the EXIT trap, so the proxy is stopped.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  preflight "$project" "$instance"
  # A missing flag fails instead of waiting at a prompt.
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1

  local run_sa="warden-run@$project.iam.gserviceaccount.com"
  local migrate_sa="warden-migrate@$project.iam.gserviceaccount.com"
  local deploy_sa="warden-deploy@$project.iam.gserviceaccount.com"
  local daily_sa="warden-daily@$project.iam.gserviceaccount.com"
  local preview_run_sa="warden-preview-run@$project.iam.gserviceaccount.com"
  local preview_migrate_sa="warden-preview-migrate@$project.iam.gserviceaccount.com"
  local preview_deploy_sa="warden-preview-deploy@$project.iam.gserviceaccount.com"
  local scheduler_sa="warden-scheduler@$project.iam.gserviceaccount.com"

  step "1. APIs"
  run gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com iam.googleapis.com sts.googleapis.com iamcredentials.googleapis.com \
    cloudscheduler.googleapis.com --project="$project"

  step "2. Artifact Registry (warden for releases, warden-preview for owner previews)"
  local repository
  for repository in "$REPOSITORY" "$PREVIEW_REPOSITORY"; do
    if ! exists gcloud artifacts repositories describe "$repository" --location="$REGION" --project="$project"; then
      run gcloud artifacts repositories create "$repository" --repository-format=docker --location="$REGION" \
        --project="$project"
    fi
  done

  step "3. Cloud SQL"
  local database
  for database in warden warden_preview; do
    if ! exists gcloud sql databases describe "$database" --instance="$instance" --project="$project"; then
      run gcloud sql databases create "$database" --instance="$instance" --project="$project"
    fi
  done
  local pitr
  pitr=$(query "" gcloud sql instances describe "$instance" --project="$project" \
    --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)')
  local recovery=(--enable-point-in-time-recovery)
  if [[ $pitr == True ]]; then
    recovery=()
  else
    note "WARNING: turning on point-in-time recovery restarts $instance: open connections close and must reconnect"
  fi
  run gcloud sql instances patch "$instance" --backup-start-time=03:00 --retained-backups-count="$BACKUPS" \
    ${recovery[@]+"${recovery[@]}"} --retained-transaction-log-days="$LOG_DAYS" --project="$project"
  # D7: no address reaches the database directly. It keeps its public IP: Cloud Run's built-in connection goes
  # through the Cloud SQL Auth Proxy, authorized by IAM, which connector enforcement admits.
  run gcloud sql instances patch "$instance" --clear-authorized-networks --connector-enforcement=REQUIRED \
    --project="$project"

  step "4. Logging"
  run gcloud logging buckets update _Default --location=global --retention-days=30 --project="$project"
  note "auditConfigs gains: $SECRET_READS_SERVICE DATA_READ"
  if dry_run; then
    print_command gcloud projects get-iam-policy "$project" --format=json
    print_command gcloud projects set-iam-policy "$project" "<that policy, with the audit config added>"
  else
    POLICY_FILE=$(mktemp)
    gcloud projects get-iam-policy "$project" --format=json | with_secret_reads_logged >"$POLICY_FILE"
    gcloud projects set-iam-policy "$project" "$POLICY_FILE" --format=none
  fi

  step "5. Secrets"
  local secret
  for secret in ${GENERATED_SECRETS[@]+"${GENERATED_SECRETS[@]}"}; do
    if exists gcloud secrets describe "$secret" --project="$project"; then continue; fi
    local create=(gcloud secrets create "$secret" --replication-policy=user-managed --locations="$REGION"
      --data-file=- --project="$project")
    if dry_run; then
      printf '<random value> | %s\n' "$(print_command ${create[@]+"${create[@]}"})"
    else
      random_password | ${create[@]+"${create[@]}"}
    fi
  done
  note "Each secret's replication: each should be user-managed, in $REGION only"
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key \
    ${GENERATED_SECRETS[@]+"${GENERATED_SECRETS[@]}"}; do
    run gcloud secrets describe "$secret" --format='yaml(name,replication)' --project="$project"
  done

  step "6. Database roles (from this machine, as postgres, through the Cloud SQL Auth Proxy)"
  # No service account reads the postgres password: the roles are made here, so rerun this script after a change to
  # createRoles. Each set on its own database, so neither can connect to the other's.
  local connection="$project:$REGION:$instance"
  if dry_run; then
    printf '%s &\n' "$(print_command cloud-sql-proxy --quiet --address=127.0.0.1 --port=LOCAL_PORT "$connection")"
    print_roles live warden warden-db-app-password warden-db-migrate-password warden-db-admin-password
    print_roles preview warden_preview warden-db-preview-app-password warden-db-preview-migrate-password
    note "then the proxy is stopped"
  else
    start_proxy "$connection"
    run_roles "$project" live warden warden-db-app-password warden-db-migrate-password warden-db-admin-password
    run_roles "$project" preview warden_preview warden-db-preview-app-password warden-db-preview-migrate-password
    cleanup
  fi

  step "7. Service accounts (none gets a key)"
  local account
  # warden-scheduler (Cloud Scheduler) gets no project role and reads no secret: its one binding is on the daily Job,
  # in step 9.
  for account in warden-run warden-migrate warden-deploy warden-daily warden-preview-run warden-preview-migrate \
    warden-preview-deploy warden-scheduler; do
    if ! exists gcloud iam service-accounts describe "$account@$project.iam.gserviceaccount.com" \
      --project="$project"; then
      run gcloud iam service-accounts create "$account" --display-name="Warden: $account" --project="$project"
    fi
  done
  for account in "$run_sa" "$migrate_sa" "$daily_sa" "$preview_run_sa" "$preview_migrate_sa"; do
    run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$account" \
      --role=roles/cloudsql.client --condition=None
  done
  grant_secrets "$project" "$run_sa" warden-clerk-secret warden-clerk-jwt-key warden-db-app-password
  grant_secrets "$project" "$migrate_sa" warden-db-app-password warden-db-migrate-password
  # warden-daily (the daily Job, ADR 0009): the only account that reads the admin password, so the server can't.
  grant_secrets "$project" "$daily_sa" warden-db-app-password warden-db-admin-password
  grant_secrets "$project" "$preview_run_sa" warden-clerk-secret warden-clerk-jwt-key warden-db-preview-app-password
  grant_secrets "$project" "$preview_migrate_sa" warden-db-preview-migrate-password
  # warden-deploy (main): Cloud Run on the project, the warden repository, the live accounts (a release updates the
  # daily Job, which runs as warden-daily).
  run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$deploy_sa" \
    --role=roles/run.developer --condition=None
  run_retrying gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" \
    --member="serviceAccount:$deploy_sa" --role=roles/artifactregistry.writer --project="$project"
  for account in "$run_sa" "$migrate_sa" "$daily_sa"; do
    run_retrying gcloud iam service-accounts add-iam-policy-binding "$account" \
      --member="serviceAccount:$deploy_sa" --role=roles/iam.serviceAccountUser --project="$project"
  done
  # warden-preview-deploy (preview/*): the warden-preview repository and the preview accounts only; its Cloud Run
  # roles are on the preview service and job, in step 9, once they exist.
  run_retrying gcloud artifacts repositories add-iam-policy-binding "$PREVIEW_REPOSITORY" --location="$REGION" \
    --member="serviceAccount:$preview_deploy_sa" --role=roles/artifactregistry.writer --project="$project"
  for account in "$preview_run_sa" "$preview_migrate_sa"; do
    run_retrying gcloud iam service-accounts add-iam-policy-binding "$account" \
      --member="serviceAccount:$preview_deploy_sa" --role=roles/iam.serviceAccountUser --project="$project"
  done

  step "8. Workload Identity Federation (main deploys as warden-deploy, preview/* as warden-preview-deploy)"
  # Only this repository, by its numeric id (a renamed or re-created repository gets another), only a push or a
  # manual dispatch, and only on its main and preview/* branches: a workflow on another branch, or started by any
  # other event (a pull request, pull_request_target, a schedule), gets no token.
  local condition="assertion.repository_id == \"$GITHUB_REPO_ID\" && assertion.event_name in [\"push\", \"workflow_dispatch\"] && (assertion.ref == \"refs/heads/main\" || assertion.ref.startsWith(\"refs/heads/preview/\"))"
  # google.subject "can't exceed 127 characters" (Google's Workload Identity Federation docs), and GitHub's `sub`
  # holds the branch name, which has no such bound: the subject is the repository and the run, at most about 40.
  # attribute.deploy says which deploy account a token may act as: <repository id>:main or <repository id>:preview.
  # The repository id is in the value, so a token from another repository (through another provider in the pool)
  # can never match a binding. (No comma in it: gcloud splits the mapping on commas.)
  local mapping="google.subject=assertion.repository_id + \":\" + assertion.run_id + \":\" + assertion.run_attempt,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.deploy=assertion.repository_id + \":\" + (assertion.ref == \"refs/heads/main\" ? \"main\" : (assertion.ref.startsWith(\"refs/heads/preview/\") ? \"preview\" : \"other\"))"
  note "GitHub repository: $GITHUB_REPO (id $GITHUB_REPO_ID)"
  if ! exists gcloud iam workload-identity-pools describe "$POOL" --location=global --project="$project"; then
    run gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" \
      --project="$project"
  fi
  local provider_verb=create-oidc
  if exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" \
    --location=global --project="$project"; then
    provider_verb=update-oidc
  fi
  run gcloud iam workload-identity-pools providers "$provider_verb" "$PROVIDER" --workload-identity-pool="$POOL" \
    --location=global --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="$mapping" \
    --attribute-condition="$condition" --project="$project"
  local number
  number=$(query "PROJECT_NUMBER" gcloud projects describe "$project" --format='value(projectNumber)')
  local pool_name="projects/$number/locations/global/workloadIdentityPools/$POOL"
  run_retrying gcloud iam service-accounts add-iam-policy-binding "$deploy_sa" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/$pool_name/attribute.deploy/$GITHUB_REPO_ID:main" \
    --project="$project"
  run_retrying gcloud iam service-accounts add-iam-policy-binding "$preview_deploy_sa" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/$pool_name/attribute.deploy/$GITHUB_REPO_ID:preview" \
    --project="$project"

  step "9. The services, the preview migration job, and the daily Job with its Cloud Scheduler trigger"
  # Made here because the deploy accounts can't set IAM policy, so they can't make a service public or let Scheduler
  # start a Job, and warden-preview-deploy's Cloud Run roles are on the preview service and job themselves. Sign-in is
  # Clerk's job.
  ensure_service "$project" "$SERVICE" "$run_sa" 2
  ensure_service "$project" "$PREVIEW_SERVICE" "$preview_run_sa" 1
  ensure_job "$project" "$PREVIEW_JOB" "$preview_migrate_sa"
  run_retrying gcloud run services add-iam-policy-binding "$PREVIEW_SERVICE" --region="$REGION" \
    --member="serviceAccount:$preview_deploy_sa" --role=roles/run.developer --project="$project"
  run_retrying gcloud run jobs add-iam-policy-binding "$PREVIEW_JOB" --region="$REGION" \
    --member="serviceAccount:$preview_deploy_sa" --role=roles/run.developer --project="$project"
  # The daily Job (ADR 0009): a release gives it Warden's image and settings. Cloud Scheduler starts it without
  # overrides, so run.invoker (which holds run.jobs.run) is all warden-scheduler needs.
  ensure_job "$project" "$DAILY_JOB" "$daily_sa"
  run_retrying gcloud run jobs add-iam-policy-binding "$DAILY_JOB" --region="$REGION" \
    --member="serviceAccount:$scheduler_sa" --role=roles/run.invoker --project="$project"
  local trigger_verb=create
  if exists gcloud scheduler jobs describe "$DAILY_JOB" --location="$REGION" --project="$project"; then
    trigger_verb=update
  fi
  run gcloud scheduler jobs "$trigger_verb" http "$DAILY_JOB" --location="$REGION" --schedule="$DAILY_SCHEDULE" \
    --time-zone=Etc/UTC \
    --uri="https://run.googleapis.com/v2/projects/$project/locations/$REGION/jobs/$DAILY_JOB:run" \
    --http-method=POST --oauth-service-account-email="$scheduler_sa" --project="$project"

  step "The database's network"
  note "Why the public IP stays: a private IP needs a VPC network, private services access and Direct VPC egress,"
  note "which Warden has none of. With no authorized networks and connectors required, only the Cloud SQL Auth"
  note "Proxy and Google's connectors, authorized by IAM, can connect."
  run gcloud sql instances describe "$instance" \
    --format='yaml(ipAddresses,settings.ipConfiguration,settings.connectorEnforcement)' --project="$project"

  step "10. Repository variables: paste these (names and ids only, no secret)"
  print_command gh variable set GCP_PROJECT_ID --body "$project" --repo "$GITHUB_REPO"
  print_command gh variable set GCP_WIF_PROVIDER --body "$pool_name/providers/$PROVIDER" --repo "$GITHUB_REPO"
  print_command gh variable set GCP_DEPLOY_SA --body "$deploy_sa" --repo "$GITHUB_REPO"
  print_command gh variable set GCP_PREVIEW_DEPLOY_SA --body "$preview_deploy_sa" --repo "$GITHUB_REPO"
  print_command gh variable set CLOUD_SQL_CONNECTION --body "$connection" --repo "$GITHUB_REPO"
  # Public by design; read from the keyring when the line is pasted.
  # shellcheck disable=SC2016 # printed for the owner to run, not expanded here
  printf '%s\n' 'gh variable set VITE_CLERK_PUBLISHABLE_KEY --body "$(secret-tool lookup service warden-clerk-publishable)" --repo '"$GITHUB_REPO"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
