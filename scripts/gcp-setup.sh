#!/usr/bin/env bash
# Sets up Warden's Google Cloud project, once: the APIs, the Docker repositories, the database's backups and network,
# log retention and Secret Manager's audit logs, one password secret per database role and one pseudonym key per
# service, the database roles themselves, two sets of service accounts (live, with the daily Job's and the Scan Job's,
# and owner previews), GitHub's deploy identities, the two public services, the preview migration job, the daily
# expiry Job with the Cloud Scheduler job that starts it, and the Scan Jobs (warden-scan, and warden-scan-preview for
# owner previews), which the service starts for a Lead's Scan. Safe to run again: it creates only what's missing, and
# sets each setting to the value below whatever it was. README.md's "Setting up Google Cloud" says what it makes, and
# why.
#
# Usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>
#        DRY_RUN=1 prints each command instead of running it, needs no credentials, and assumes nothing exists yet.
#        Unset, empty or 0 is a real run. Any other value stops it before anything runs.
# Env:   WARDEN_GITHUB_REPO (<owner>/<repo>) and WARDEN_GITHUB_REPO_ID (its numeric id:
#        `gh api repos/<owner>/<repo> --jq .id`), both required: the one GitHub repository that may deploy.
# Needs: for a real run, gcloud signed in, application-default credentials (gcloud auth application-default login)
#        whose quota project is <project-id> or unset (and GOOGLE_CLOUD_QUOTA_PROJECT and CSQL_PROXY_QUOTA_PROJECT
#        <project-id> or unset), node, cloud-sql-proxy, and the server's dependencies
#        (pnpm install): the roles step runs server/src/roles.ts from this machine.
#
# No secret value is printed, logged or written to a file: each password and key is generated in a pipe straight into
# `gcloud secrets create --data-file=-`; a password is read back only into the one roles process's environment, and a
# key never.
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
# The Scan Job (ADR 0009): the service starts one execution per Scan, with the Scan's id and Team as its override.
readonly SCAN_JOB=warden-scan
# An owner preview's Scan Job (#275): the same, on the preview database, as warden-preview-scan.
readonly PREVIEW_SCAN_JOB=warden-scan-preview
readonly SERVICE_IMAGE=us-docker.pkg.dev/cloudrun/container/hello
readonly JOB_IMAGE=us-docker.pkg.dev/cloudrun/container/job:latest
readonly POOL=github
readonly PROVIDER=warden
readonly SECRET_READS_SERVICE=secretmanager.googleapis.com
# Cloud SQL's docs: "the transaction log retention setting must be less than the backup retention setting".
readonly BACKUPS=7
readonly LOG_DAYS=6
# The secrets the script generates: the database passwords (each set's app and migration roles, and the live admin
# role's, which only the daily Job reads), and the hook's pseudonym keys (#185), the live service's and a preview's
# own. The keys are never rotated: a new key gives every developer a new pseudonym, so their earlier Agent sessions
# no longer match. (Assigned, then made readonly: the form bash 3.2 accepts.)
GENERATED_SECRETS=(warden-db-app-password warden-db-migrate-password warden-db-preview-app-password
  warden-db-preview-migrate-password warden-db-admin-password warden-pseudonym-key warden-preview-pseudonym-key)
readonly GENERATED_SECRETS
# The write GitHub app's two (#334), made by hand and optional: it opens Fix PRs, and only the two services read it.
# The write app is both or neither: preflight stops on one alone.
WRITE_APP_SECRETS=(warden-github-write-app-client-secret warden-github-write-app-private-key)
readonly WRITE_APP_SECRETS
# The Judge's three (#482), made by hand and required: the OpenRouter key a Judge run calls the model with, and the
# Langfuse keys it traces with. Only the two Scan Jobs' accounts read them.
JUDGE_SECRETS=(warden-openrouter-api-key warden-langfuse-public-key warden-langfuse-secret-key)
readonly JUDGE_SECRETS
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

# GCP's 429: RESOURCE_EXHAUSTED, as gcloud prints a quota refusal (or the bare HTTP code).
readonly QUOTA_EXCEEDED='RESOURCE_EXHAUSTED|HTTPError 429'
# A 429's wait, when its RetryInfo gives none: the quota on service-account creates is per minute.
readonly QUOTA_WAIT=60
# A longer RetryInfo wait than this isn't the per-minute quota (a hard limit says a day): it isn't waited for.
readonly QUOTA_WAIT_MAX=300
readonly QUOTA_RETRIES=3

# How long a 429 says to wait, in whole seconds rounded up: its RetryInfo's retryDelay, as gcloud prints an error's
# details (retryDelay: 42s, or 41.2s), or QUOTA_WAIT when it has none.
quota_wait() {
  if [[ $1 =~ retryDelay\"?:[[:space:]]*\"?([0-9]+)(\.[0-9]+)?s ]]; then
    local seconds=${BASH_REMATCH[1]}
    if [[ -n ${BASH_REMATCH[2]} ]]; then seconds=$((10#$seconds + 1)); fi
    printf '%s' "$((10#$seconds))"
  else
    printf '%s' "$QUOTA_WAIT"
  fi
}

# Runs a create that GCP may refuse with 429 (its per-minute quota on service-account creates): tried again after
# the wait the error gives, QUOTA_RETRIES times at most. Any other error, a 429 past the last retry, or one that says
# to wait longer than QUOTA_WAIT_MAX stops the script, printing gcloud's error.
run_quota_retrying() {
  if dry_run; then
    print_command "$@"
    return
  fi
  local try=0 error delay status
  while true; do
    status=0
    # Its error kept to read, its output shown as it goes.
    { error=$("$@" 2>&1 >&3); } 3>&1 || status=$?
    if [[ $status == 0 ]]; then
      if [[ -n $error ]]; then printf '%s\n' "$error" >&2; fi
      return 0
    fi
    if [[ $error =~ $QUOTA_EXCEEDED ]] && ((try < QUOTA_RETRIES)); then
      delay=$(quota_wait "$error")
      if ((delay <= QUOTA_WAIT_MAX)); then
        try=$((try + 1))
        echo "  GCP's quota refused it (429); retrying in ${delay}s ($try of $QUOTA_RETRIES)" >&2
        sleep "$delay"
        continue
      fi
    fi
    printf 'gcp-setup: %s failed:\n%s\n' "$(print_command "$@")" "$error" >&2
    exit "$status"
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

# Whether both of the write app's secrets exist in <project>. Preflight has already stopped a run with one alone.
write_app_present() {
  local secret
  for secret in ${WRITE_APP_SECRETS[@]+"${WRITE_APP_SECRETS[@]}"}; do
    exists gcloud secrets describe "$secret" --project="$1" || return 1
  done
}

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

# The quota project in the application-default credentials, or nothing when they set none. No gcloud command prints
# it: it's the credentials file's quota_project_id, which gcloud and Google's client libraries (the proxy's) read
# from GOOGLE_APPLICATION_CREDENTIALS when set, otherwise from gcloud's config folder (CLOUDSDK_CONFIG, or
# ~/.config/gcloud). No file in gcloud's folder (credentials from a metadata server): nothing. A file
# GOOGLE_APPLICATION_CREDENTIALS names that doesn't exist, one it can't read, and one that isn't valid JSON each fail
# with that alone: JSON.parse's own error quotes the file, which holds secrets (client_secret, refresh_token).
adc_quota_project() {
  local config=${CLOUDSDK_CONFIG:-$HOME/.config/gcloud}
  local file=${GOOGLE_APPLICATION_CREDENTIALS:-$config/application_default_credentials.json}
  if [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} && ! -e $file ]]; then
    echo "gcp-setup: the file GOOGLE_APPLICATION_CREDENTIALS names doesn't exist: $file" >&2
    return 1
  fi
  if [[ ! -e $file ]]; then return 0; fi
  node -e '
    const file = process.argv[1];
    let text, credentials;
    try {
      text = require("node:fs").readFileSync(file, "utf8");
    } catch {
      process.stderr.write(`gcp-setup: can'\''t read ${file}, the application-default credentials file\n`);
      process.exit(1);
    }
    try {
      credentials = JSON.parse(text);
    } catch {
      process.stderr.write(`gcp-setup: the application-default credentials file ${file} isn'\''t valid JSON\n`);
      process.exit(1);
    }
    const quota = credentials?.quota_project_id;
    if (typeof quota === "string") process.stdout.write(quota);
  ' "$file"
}

# The proxy bills its Cloud SQL Admin API calls to a quota project: another project than <project>, where that API may
# be off, refuses them, and the roles step fails with a bare ECONNRESET. The proxy takes the first of its
# --quota-project flag (CSQL_PROXY_QUOTA_PROJECT: it reads each flag from CSQL_PROXY_<FLAG>), then
# GOOGLE_CLOUD_QUOTA_PROJECT, then the credentials file's quota project (its Google auth library: the override, then
# the variable, then the file). An empty variable counts as unset there too; a blank one (spaces) is taken as it is.
# The file is read first whichever wins, as the proxy still signs in with it.
check_quota_project() {
  local project=$1 quota name value
  if ! quota=$(adc_quota_project); then
    echo "gcp-setup: couldn't read the application-default credentials' quota project; nothing was changed" >&2
    exit 1
  fi
  for name in CSQL_PROXY_QUOTA_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT; do
    value=${!name-}
    if [[ -z $value ]]; then continue; fi
    if [[ -z ${value//[[:space:]]/} ]]; then
      echo "gcp-setup: $name is set but blank; unset it, or set it to $project. The Cloud SQL Auth Proxy" \
        "would bill its calls to a project with no name, and they would be refused. Nothing was changed." >&2
      exit 1
    fi
    if [[ $value != "$project" ]]; then
      echo "gcp-setup: $name is '$value', not '$project', and the Cloud SQL Auth Proxy bills its calls there first," \
        "so they would be refused; unset it, or set it to $project. Nothing was changed." >&2
      exit 1
    fi
    return 0
  done
  if [[ -n $quota && $quota != "$project" ]]; then
    echo "gcp-setup: the application-default credentials' quota project is '$quota', not '$project'," \
      "so the Cloud SQL Auth Proxy's calls would be refused; run" \
      "gcloud auth application-default set-quota-project $project first. Nothing was changed." >&2
    exit 1
  fi
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
  local project=$1 instance=$2 missing=() write_missing=() secret
  # Before gcloud is asked for a token: with a credentials file missing or unreadable, gcloud's own failure would
  # hide the script's message, which names the file.
  check_quota_project "$project"
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    echo "gcp-setup: no application-default credentials for the Cloud SQL Auth Proxy;" \
      "run gcloud auth application-default login first" >&2
    exit 1
  fi
  # What the owner makes by hand, checked before any change.
  exists gcloud sql instances describe "$instance" --project="$project" ||
    missing+=("Cloud SQL instance $instance")
  # The GitHub app's two (#132's steps) are made by hand too: the live service reads them. So are the Judge's three
  # (#482), which the Scan Jobs read.
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key \
    warden-github-app-client-secret warden-github-app-private-key ${JUDGE_SECRETS[@]+"${JUDGE_SECRETS[@]}"}; do
    exists gcloud secrets describe "$secret" --project="$project" || missing+=("secret $secret")
  done
  # The write app's two: both, and it's granted; neither, and Fix PRs stay off (step 10 says so); one alone stops here.
  for secret in ${WRITE_APP_SECRETS[@]+"${WRITE_APP_SECRETS[@]}"}; do
    exists gcloud secrets describe "$secret" --project="$project" || write_missing+=("$secret")
  done
  if [[ ${#write_missing[@]} -eq 1 ]]; then
    missing+=("secret ${write_missing[0]} (the write app needs both its secrets, or neither)")
  fi
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

# run_roles <project> <instance> <set> <database> <app secret> <migrate secret> [admin secret]: the roles script for
# one set, on its own database, as postgres, through the proxy. Each password goes from Secret Manager into this one
# process's environment only (a prefix assignment, not an argument). Without an admin secret, the admin role gets no
# password (the preview set: no preview Job runs as it, so it can't log in). A failure stops the script with the roles
# script's exit code; its own error, which holds no password, is above. When postgres's login is refused (28P01), it
# also says how to reset that password from warden-db-password.
run_roles() {
  local project=$1 instance=$2 set=$3 database=$4 app_secret=$5 migrate_secret=$6 admin_secret=${7-}
  local postgres_password app_password migrate_password admin_password="" status=0 output
  postgres_password=$(gcloud secrets versions access latest --secret=warden-db-password --project="$project")
  app_password=$(gcloud secrets versions access latest --secret="$app_secret" --project="$project")
  migrate_password=$(gcloud secrets versions access latest --secret="$migrate_secret" --project="$project")
  if [[ -n $admin_secret ]]; then
    admin_password=$(gcloud secrets versions access latest --secret="$admin_secret" --project="$project")
  fi
  note "the $set roles, on $database"
  # Its output is kept to look for the refused login: printed on stdout when it succeeds, and on stderr, above the
  # script's own error, when it fails.
  output=$(WARDEN_DATABASE_ROLES=$set PGHOST=127.0.0.1 PGPORT=$PROXY_PORT PGUSER=postgres PGDATABASE=$database \
    PGPASSWORD=$postgres_password WARDEN_APP_PASSWORD=$app_password WARDEN_MIGRATE_PASSWORD=$migrate_password \
    WARDEN_ADMIN_PASSWORD=$admin_password node "$ROOT/server/src/roles.ts" 2>&1) || status=$?
  if [[ $status == 0 ]]; then
    if [[ -n $output ]]; then printf '%s\n' "$output"; fi
    return 0
  fi
  if [[ -n $output ]]; then printf '%s\n' "$output" >&2; fi
  echo "gcp-setup: the roles step failed for the $set set on $database (exit $status);" \
    "the roles script's error is above" >&2
  if [[ $output =~ 28P01|password\ authentication\ failed ]]; then
    # shellcheck disable=SC2016 # printed for the owner to paste: the secret is read then, not here
    echo "gcp-setup: the postgres password doesn't match the secret warden-db-password;" \
      "reset it with this command, then run this script again:" >&2
    printf '  %s\n' "gcloud sql users set-password postgres --instance=$instance --project=$project"' --password="$(gcloud secrets versions access latest --secret=warden-db-password --project='"$project"')"' >&2
  fi
  exit "$status"
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
  # Whether to describe, grant and print what the write app needs (#334): when both of its secrets exist; a dry run,
  # which assumes nothing exists, prints them all under one note.
  local write_app=no
  if dry_run; then
    note "DRY_RUN: the write app's replication, grants and variable line below print as they would" \
      "when both of the write app's secrets exist"
    write_app=yes
  elif write_app_present "$project"; then
    write_app=yes
  fi
  # A missing flag fails instead of waiting at a prompt.
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1

  local run_sa="warden-run@$project.iam.gserviceaccount.com"
  local migrate_sa="warden-migrate@$project.iam.gserviceaccount.com"
  local deploy_sa="warden-deploy@$project.iam.gserviceaccount.com"
  local daily_sa="warden-daily@$project.iam.gserviceaccount.com"
  local scan_sa="warden-scan@$project.iam.gserviceaccount.com"
  local preview_run_sa="warden-preview-run@$project.iam.gserviceaccount.com"
  local preview_migrate_sa="warden-preview-migrate@$project.iam.gserviceaccount.com"
  local preview_deploy_sa="warden-preview-deploy@$project.iam.gserviceaccount.com"
  local preview_scan_sa="warden-preview-scan@$project.iam.gserviceaccount.com"
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
  # through the Cloud SQL Auth Proxy, authorized by IAM, which connector enforcement admits. And it takes only
  # encrypted connections, so a plain one is refused even if a connector ever let it through.
  run gcloud sql instances patch "$instance" --clear-authorized-networks --connector-enforcement=REQUIRED \
    --ssl-mode=ENCRYPTED_ONLY --project="$project"

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
  # docs/data.md's Secret Manager row: the four made by hand outside the GitHub apps use automatic replication
  # (checked live, #65); this script's own, the read-only app's two and the write app's two are user-managed.
  note "Each secret's replication: warden-db-password, warden-clerk-secret, warden-clerk-publishable and" \
    "warden-clerk-jwt-key use automatic replication (made by hand); every other one should be user-managed," \
    "in $REGION only"
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key \
    warden-github-app-client-secret warden-github-app-private-key ${JUDGE_SECRETS[@]+"${JUDGE_SECRETS[@]}"} \
    ${GENERATED_SECRETS[@]+"${GENERATED_SECRETS[@]}"}; do
    run gcloud secrets describe "$secret" --format='yaml(name,replication)' --project="$project"
  done
  if [[ $write_app == yes ]]; then
    for secret in ${WRITE_APP_SECRETS[@]+"${WRITE_APP_SECRETS[@]}"}; do
      run gcloud secrets describe "$secret" --format='yaml(name,replication)' --project="$project"
    done
  fi

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
    run_roles "$project" "$instance" live warden warden-db-app-password warden-db-migrate-password \
      warden-db-admin-password
    run_roles "$project" "$instance" preview warden_preview warden-db-preview-app-password \
      warden-db-preview-migrate-password
    cleanup
  fi

  step "7. Service accounts (none gets a key)"
  local account
  # warden-scheduler (Cloud Scheduler) gets no project role and reads no secret: its one binding is on the daily Job,
  # in step 9.
  for account in warden-run warden-migrate warden-deploy warden-daily warden-scan warden-preview-run \
    warden-preview-migrate warden-preview-deploy warden-preview-scan warden-scheduler; do
    if ! exists gcloud iam service-accounts describe "$account@$project.iam.gserviceaccount.com" \
      --project="$project"; then
      run_quota_retrying gcloud iam service-accounts create "$account" --display-name="Warden: $account" \
        --project="$project"
    fi
  done
  for account in "$run_sa" "$migrate_sa" "$daily_sa" "$scan_sa" "$preview_run_sa" "$preview_migrate_sa" \
    "$preview_scan_sa"; do
    run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$account" \
      --role=roles/cloudsql.client --condition=None
  done
  grant_secrets "$project" "$run_sa" warden-clerk-secret warden-clerk-jwt-key warden-db-app-password
  # The GitHub app's client secret and private key: the live service reads both (#151). The Scan Job reads the private
  # key alone (below). A preview shares the live read-only app (#275), so its accounts get the same two.
  grant_secrets "$project" "$run_sa" warden-github-app-client-secret warden-github-app-private-key
  grant_secrets "$project" "$migrate_sa" warden-db-app-password warden-db-migrate-password
  # warden-daily (the daily Job, ADR 0009): the only account that reads the admin password, so the server can't.
  grant_secrets "$project" "$daily_sa" warden-db-app-password warden-db-admin-password
  # warden-scan (the Scan Job, ADR 0009): the app password, and the GitHub app's private key to read a Team's repos
  # (#188). It works inside one Team and lists none, so it never needs the admin password; and it never gets the
  # GitHub app's client secret, so it can't sign anyone in to GitHub.
  grant_secrets "$project" "$scan_sa" warden-db-app-password warden-github-app-private-key
  # The Judge's three (#482): a Judge run, in the Scan Job, calls OpenRouter and traces to Langfuse. The Scan Jobs'
  # accounts only, never a service's; a preview shares the key and the Langfuse project.
  grant_secrets "$project" "$scan_sa" ${JUDGE_SECRETS[@]+"${JUDGE_SECRETS[@]}"}
  grant_secrets "$project" "$preview_run_sa" warden-clerk-secret warden-clerk-jwt-key warden-db-preview-app-password
  grant_secrets "$project" "$preview_run_sa" warden-github-app-client-secret warden-github-app-private-key
  grant_secrets "$project" "$preview_migrate_sa" warden-db-preview-migrate-password
  # warden-preview-scan (the preview Scan Job, #275): warden-scan's twin, with the preview app password.
  grant_secrets "$project" "$preview_scan_sa" warden-db-preview-app-password warden-github-app-private-key
  grant_secrets "$project" "$preview_scan_sa" ${JUDGE_SECRETS[@]+"${JUDGE_SECRETS[@]}"}
  # The pseudonym keys (#185): each service reads its own and no other account either, so a preview's pseudonyms can't
  # be matched against live ones. No Scan Job reads the hook.
  grant_secrets "$project" "$run_sa" warden-pseudonym-key
  grant_secrets "$project" "$preview_run_sa" warden-preview-pseudonym-key
  # The write app's two (#334): the two services only, which open Fix PRs; a preview shares the live write app
  # (#224). Never a Scan Job, so Scans stay read-only.
  if [[ $write_app == yes ]]; then
    grant_secrets "$project" "$run_sa" ${WRITE_APP_SECRETS[@]+"${WRITE_APP_SECRETS[@]}"}
    grant_secrets "$project" "$preview_run_sa" ${WRITE_APP_SECRETS[@]+"${WRITE_APP_SECRETS[@]}"}
  fi
  # warden-deploy (main): Cloud Run on the project, the warden repository, the live accounts (a release updates the
  # daily Job and the Scan Job, which run as warden-daily and warden-scan).
  run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$deploy_sa" \
    --role=roles/run.developer --condition=None
  run_retrying gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" \
    --member="serviceAccount:$deploy_sa" --role=roles/artifactregistry.writer --project="$project"
  for account in "$run_sa" "$migrate_sa" "$daily_sa" "$scan_sa"; do
    run_retrying gcloud iam service-accounts add-iam-policy-binding "$account" \
      --member="serviceAccount:$deploy_sa" --role=roles/iam.serviceAccountUser --project="$project"
  done
  # warden-preview-deploy (preview/*): the warden-preview repository and the preview accounts only; its Cloud Run
  # roles are on the preview service and jobs, in step 9, once they exist.
  run_retrying gcloud artifacts repositories add-iam-policy-binding "$PREVIEW_REPOSITORY" --location="$REGION" \
    --member="serviceAccount:$preview_deploy_sa" --role=roles/artifactregistry.writer --project="$project"
  for account in "$preview_run_sa" "$preview_migrate_sa" "$preview_scan_sa"; do
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

  step "9. The services, the preview migration job, the daily Job with its Cloud Scheduler trigger, and the Scan Jobs"
  # Made here because the deploy accounts can't set IAM policy, so they can't make a service public or let Scheduler
  # start a Job, and warden-preview-deploy's Cloud Run roles are on the preview service and jobs themselves. Sign-in is
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
  # The Scan Job (ADR 0009): a release gives it Warden's image and settings. The service starts each execution with
  # the Scan's id and Team as an env override, which run.invoker can't pass: warden-run gets
  # run.jobsExecutorWithOverrides on this Job only.
  ensure_job "$project" "$SCAN_JOB" "$scan_sa"
  run_retrying gcloud run jobs add-iam-policy-binding "$SCAN_JOB" --region="$REGION" \
    --member="serviceAccount:$run_sa" --role=roles/run.jobsExecutorWithOverrides --project="$project"
  # The preview Scan Job (#275): a preview deploy gives it the preview's image and settings, so warden-preview-deploy
  # gets run.developer on it; the preview service starts its executions as warden-preview-run.
  ensure_job "$project" "$PREVIEW_SCAN_JOB" "$preview_scan_sa"
  run_retrying gcloud run jobs add-iam-policy-binding "$PREVIEW_SCAN_JOB" --region="$REGION" \
    --member="serviceAccount:$preview_run_sa" --role=roles/run.jobsExecutorWithOverrides --project="$project"
  run_retrying gcloud run jobs add-iam-policy-binding "$PREVIEW_SCAN_JOB" --region="$REGION" \
    --member="serviceAccount:$preview_deploy_sa" --role=roles/run.developer --project="$project"

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
  # The GitHub app's client id: public too, and from the keyring the same way. GitHub refuses a variable name that
  # starts with GITHUB_, so a release reads it as WARDEN_GITHUB_APP_CLIENT_ID.
  # shellcheck disable=SC2016 # printed for the owner to run, not expanded here
  printf '%s\n' 'gh variable set WARDEN_GITHUB_APP_CLIENT_ID --body "$(secret-tool lookup service warden-github-app-client-id)" --repo '"$GITHUB_REPO"
  # The write app's client id, the same way; a deploy passes the write app on only when it's set.
  if [[ $write_app == yes ]]; then
    # shellcheck disable=SC2016 # printed for the owner to run, not expanded here
    printf '%s\n' 'gh variable set WARDEN_GITHUB_WRITE_APP_CLIENT_ID --body "$(secret-tool lookup service warden-github-write-app-client-id)" --repo '"$GITHUB_REPO"
  else
    note "Fix PRs stay off: the write app's secrets ${WRITE_APP_SECRETS[0]} and ${WRITE_APP_SECRETS[1]} don't exist." \
      "Make both (README.md, \"Granting write access\"), then run this script again"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
