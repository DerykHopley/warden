#!/usr/bin/env bash
# Sets up Warden's Google Cloud project, once: the APIs, the Docker repository, the database's backups and network,
# log retention and Secret Manager's audit logs, one password secret per database role, three service accounts,
# GitHub's deploy identity and the public service. Safe to run again: it creates only what's missing, and sets each
# setting to the value below whatever it was. README.md's "Setting up Google Cloud" says what it makes, and why.
#
# Usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>
#        DRY_RUN=1 (exactly 1) prints each gcloud command instead of running it, needs no credentials, and assumes
#        nothing exists yet. Any other value, or none, is a real run.
# Env:   WARDEN_GITHUB_REPO (<owner>/<repo>) and WARDEN_GITHUB_REPO_ID (its numeric id:
#        `gh api repos/<owner>/<repo> --jq .id`), both required: the one GitHub repository that may deploy.
#
# No secret value is printed, logged or written to a file: each password is generated in a pipe straight into
# `gcloud secrets create --data-file=-`.
set -euo pipefail

readonly REGION=europe-west1
readonly REPOSITORY=warden
readonly SERVICE=warden
readonly POOL=github
readonly PROVIDER=warden
readonly SECRET_READS_SERVICE=secretmanager.googleapis.com
# Cloud SQL's docs: "the transaction log retention setting must be less than the backup retention setting".
readonly BACKUPS=7
readonly LOG_DAYS=6

dry_run() { [[ ${DRY_RUN:-0} == 1 ]]; }

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

# A binding made right after its service account can fail until the account is visible everywhere: tried 5 times.
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
# Cloud SQL's databases, Cloud Run's own message, and Cloud SQL's for an instance (which it also gives when you may
# not see the instance).
readonly NOT_FOUND='NOT_FOUND|HTTPError 404|Cannot find service \[|There was no instance found at '

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
    echo "gcp-setup: node isn't on PATH; it edits the project's audit-log policy" >&2
    exit 1
  fi
  # What the owner makes by hand, checked before any change.
  local project=$1 instance=$2 missing=() secret
  exists gcloud sql instances describe "$instance" --project="$project" ||
    missing+=("Cloud SQL instance $instance")
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key; do
    exists gcloud secrets describe "$secret" --project="$project" || missing+=("secret $secret")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "gcp-setup: make these first (README.md, \"Setting up Google Cloud\"); nothing was changed:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

main() {
  if [[ $# -ne 2 ]]; then
    echo "usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>" >&2
    exit 1
  fi
  local project=$1 instance=$2
  github_repository
  preflight "$project" "$instance"
  # A missing flag fails instead of waiting at a prompt.
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1

  local run_sa="warden-run@$project.iam.gserviceaccount.com"
  local migrate_sa="warden-migrate@$project.iam.gserviceaccount.com"
  local deploy_sa="warden-deploy@$project.iam.gserviceaccount.com"

  step "1. APIs"
  run gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com iam.googleapis.com sts.googleapis.com iamcredentials.googleapis.com \
    --project="$project"

  step "2. Artifact Registry"
  if ! exists gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" --project="$project"; then
    run gcloud artifacts repositories create "$REPOSITORY" --repository-format=docker --location="$REGION" \
      --project="$project"
  fi

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
    "${recovery[@]}" --retained-transaction-log-days="$LOG_DAYS" --project="$project"
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
    local policy
    policy=$(mktemp)
    # shellcheck disable=SC2064 # the path is fixed now
    trap "rm -f '$policy'" EXIT
    gcloud projects get-iam-policy "$project" --format=json | with_secret_reads_logged >"$policy"
    gcloud projects set-iam-policy "$project" "$policy" --format=none
  fi

  step "5. Secrets"
  local secret
  for secret in warden-db-app-password warden-db-migrate-password; do
    if exists gcloud secrets describe "$secret" --project="$project"; then continue; fi
    local create=(gcloud secrets create "$secret" --replication-policy=user-managed --locations="$REGION"
      --data-file=- --project="$project")
    if dry_run; then
      printf '<random value> | %s\n' "$(print_command "${create[@]}")"
    else
      random_password | "${create[@]}"
    fi
  done
  note "Each secret's replication: each should be user-managed, in $REGION only"
  for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key \
    warden-db-app-password warden-db-migrate-password; do
    run gcloud secrets describe "$secret" --format='yaml(name,replication)' --project="$project"
  done

  step "6. Service accounts (none gets a key)"
  local account
  for account in warden-run warden-migrate warden-deploy; do
    if ! exists gcloud iam service-accounts describe "$account@$project.iam.gserviceaccount.com" \
      --project="$project"; then
      run gcloud iam service-accounts create "$account" --display-name="Warden: $account" --project="$project"
    fi
  done
  for account in "$run_sa" "$migrate_sa"; do
    run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$account" \
      --role=roles/cloudsql.client --condition=None
  done
  for secret in warden-clerk-secret warden-clerk-jwt-key warden-db-app-password; do
    run_retrying gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$run_sa" \
      --role=roles/secretmanager.secretAccessor --project="$project"
  done
  for secret in warden-db-password warden-db-app-password warden-db-migrate-password; do
    run_retrying gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$migrate_sa" \
      --role=roles/secretmanager.secretAccessor --project="$project"
  done
  run_retrying gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$deploy_sa" \
    --role=roles/run.developer --condition=None
  run_retrying gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" \
    --member="serviceAccount:$deploy_sa" --role=roles/artifactregistry.writer --project="$project"
  for account in "$run_sa" "$migrate_sa"; do
    run_retrying gcloud iam service-accounts add-iam-policy-binding "$account" \
      --member="serviceAccount:$deploy_sa" --role=roles/iam.serviceAccountUser --project="$project"
  done

  step "7. Workload Identity Federation (GitHub Actions deploys as warden-deploy)"
  # Only this repository, by its numeric id (a renamed or re-created repository gets another), only a push or a
  # manual dispatch, and only on its main and preview/* branches: a workflow on another branch, or started by any
  # other event (a pull request, pull_request_target, a schedule), gets no token.
  local condition="assertion.repository_id == \"$GITHUB_REPO_ID\" && assertion.event_name in [\"push\", \"workflow_dispatch\"] && (assertion.ref == \"refs/heads/main\" || assertion.ref.startsWith(\"refs/heads/preview/\"))"
  # google.subject "can't exceed 127 characters" (Google's Workload Identity Federation docs), and GitHub's `sub`
  # holds the branch name, which has no such bound: the subject is the repository and the run, at most about 40.
  local mapping="google.subject=assertion.repository_id + \":\" + assertion.run_id + \":\" + assertion.run_attempt,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name"
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
    --member="principalSet://iam.googleapis.com/$pool_name/attribute.repository_id/$GITHUB_REPO_ID" \
    --project="$project"

  step "8. The service"
  # Made here because warden-deploy can't set IAM policy, so it can't make a service public. Sign-in is Clerk's job.
  if ! exists gcloud run services describe "$SERVICE" --region="$REGION" --project="$project"; then
    run gcloud run deploy "$SERVICE" --image=us-docker.pkg.dev/cloudrun/container/hello --region="$REGION" \
      --service-account="$run_sa" --allow-unauthenticated --max-instances=2 --project="$project"
  else
    # Its settings put back, keeping whatever image it runs now.
    run gcloud run services update "$SERVICE" --region="$REGION" --service-account="$run_sa" --max-instances=2 \
      --project="$project"
    run_retrying gcloud run services add-iam-policy-binding "$SERVICE" --region="$REGION" --member=allUsers \
      --role=roles/run.invoker --project="$project"
  fi

  step "The database's network"
  note "Why the public IP stays: a private IP needs a VPC network, private services access and Direct VPC egress,"
  note "which Warden has none of. With no authorized networks and connectors required, only the Cloud SQL Auth"
  note "Proxy and Google's connectors, authorized by IAM, can connect."
  run gcloud sql instances describe "$instance" \
    --format='yaml(ipAddresses,settings.ipConfiguration,settings.connectorEnforcement)' --project="$project"

  step "9. Repository variables: paste these (names and ids only, no secret)"
  print_command gh variable set GCP_PROJECT_ID --body "$project" --repo "$GITHUB_REPO"
  print_command gh variable set GCP_WIF_PROVIDER --body "$pool_name/providers/$PROVIDER" --repo "$GITHUB_REPO"
  print_command gh variable set GCP_DEPLOY_SA --body "$deploy_sa" --repo "$GITHUB_REPO"
  print_command gh variable set CLOUD_SQL_CONNECTION --body "$project:$REGION:$instance" --repo "$GITHUB_REPO"
  # Public by design; read from the keyring when the line is pasted.
  # shellcheck disable=SC2016 # printed for the owner to run, not expanded here
  printf '%s\n' 'gh variable set VITE_CLERK_PUBLISHABLE_KEY --body "$(secret-tool lookup service warden-clerk-publishable)" --repo '"$GITHUB_REPO"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
