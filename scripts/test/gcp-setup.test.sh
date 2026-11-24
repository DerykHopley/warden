#!/usr/bin/env bash
# The Google Cloud setup script, run with DRY_RUN=1: asserts on the gcloud commands it prints, so nothing reaches
# Google and no credentials are needed. Stops at the first failed assertion, exiting 1.
# Run from anywhere: scripts/test/gcp-setup.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
setup="$root/scripts/gcp-setup.sh"
project=test-project
instance=test-db
repo_id=1468893661

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}
pass() { printf 'ok: %s\n' "$1"; }

# assert_equal <what> <expected> <actual>
assert_equal() {
  [[ "$2" == "$3" ]] || fail "$1"$'\n'"--- expected"$'\n'"$2"$'\n'"--- got"$'\n'"$3"
  pass "$1"
}

# assert_line <what> <fixed string>: some line of the output contains it.
assert_line() {
  grep -qF -- "$2" <<<"$output" || fail "$1: no line contains: $2"
  pass "$1"
}

# assert_no_line <what> <fixed string>
assert_no_line() {
  if grep -qF -- "$2" <<<"$output"; then fail "$1: a line contains: $2"; fi
  pass "$1"
}

output=$(DRY_RUN=1 "$setup" "$project" "$instance")

# Every IAM binding granted to a service account, one per line as "<kind> <resource> <role>", sorted.
bindings_to() {
  local member="--member=serviceAccount:$1@$project.iam.gserviceaccount.com"
  grep -F -- 'add-iam-policy-binding' <<<"$output" | grep -F -- "$member" | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i == "add-iam-policy-binding") target = $(i + 1)
      if ($i ~ /^--role=/) role = substr($i, 8)
    }
    print $2, target, role
  }' | sort
}

assert_equal "warden-run gets Cloud SQL client and three secrets, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-clerk-jwt-key roles/secretmanager.secretAccessor
secrets warden-clerk-secret roles/secretmanager.secretAccessor
secrets warden-db-app-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-run)"

assert_equal "warden-migrate gets Cloud SQL client and the three database secrets, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-db-app-password roles/secretmanager.secretAccessor
secrets warden-db-migrate-password roles/secretmanager.secretAccessor
secrets warden-db-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-migrate)"

assert_equal "warden-deploy gets run.developer, the warden repository's writer, and acts as run and migrate only" \
  "artifacts warden roles/artifactregistry.writer
iam warden-migrate@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
iam warden-run@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
projects $project roles/run.developer" \
  "$(bindings_to warden-deploy)"

assert_line "the repository binding is on the warden repository in europe-west1" \
  "gcloud artifacts repositories add-iam-policy-binding warden --location=europe-west1"

assert_no_line "no service account key is made" "keys create"

# The Workload Identity provider: this repository by its numeric id, and only main and preview/* branches.
condition=$(grep -F 'providers create-oidc' <<<"$output" | grep -o "'--attribute-condition=[^']*'" || true)
assert_equal "the provider admits only this repository's main and preview/* refs" \
  "'--attribute-condition=assertion.repository_id == \"$repo_id\" && (assertion.ref == \"refs/heads/main\" || assertion.ref.startsWith(\"refs/heads/preview/\"))'" \
  "$condition"
assert_line "the pool may act as warden-deploy, for this repository only" \
  "--role=roles/iam.workloadIdentityUser --member=principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$repo_id"

assert_line "authorized networks are cleared and connectors are required" \
  "gcloud sql instances patch $instance --clear-authorized-networks --connector-enforcement=REQUIRED --project=$project"
assert_line "7 backups are kept, with 6 days of recovery logs (fewer than the backups, as Cloud SQL's docs say)" \
  "--retained-backups-count=7 --enable-point-in-time-recovery --retained-transaction-log-days=6"
assert_line "it warns that turning on point-in-time recovery restarts the instance" \
  "restarts $instance"

assert_line "it creates the warden database" "gcloud sql databases create warden --instance=$instance"
assert_line "it creates the warden_preview database" \
  "gcloud sql databases create warden_preview --instance=$instance"

assert_line "the _Default log bucket keeps 30 days" \
  "gcloud logging buckets update _Default --location=global --retention-days=30"

# Data Access logs: only Secret Manager's reads, merged into the project's policy by with_secret_reads_logged.
assert_equal "the only Data Access logs turned on are Secret Manager's reads" \
  "# auditConfigs gains: secretmanager.googleapis.com DATA_READ" \
  "$(grep -F 'DATA_READ' <<<"$output")"
assert_line "the edited policy is written back" "gcloud projects set-iam-policy $project"

for secret in warden-db-app-password warden-db-migrate-password; do
  assert_line "$secret is made from a random value piped in, in europe-west1 only" \
    "<random value> | gcloud secrets create $secret --replication-policy=user-managed --locations=europe-west1 --data-file=- --project=$project"
done
for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key \
  warden-db-app-password warden-db-migrate-password; do
  assert_line "$secret's replication is printed" \
    "gcloud secrets describe $secret '--format=yaml(name,replication)' --project=$project"
done

assert_line "the service runs as warden-run, public, at most 2 instances" \
  "gcloud run deploy warden --image=us-docker.pkg.dev/cloudrun/container/hello --region=europe-west1 --service-account=warden-run@$project.iam.gserviceaccount.com --allow-unauthenticated --max-instances=2 --project=$project"

variables=$(grep -E '^gh variable set' <<<"$output" | awk '{ print $4 }' | sort)
assert_equal "a gh variable line for each of the five variables" \
  "CLOUD_SQL_CONNECTION
GCP_DEPLOY_SA
GCP_PROJECT_ID
GCP_WIF_PROVIDER
VITE_CLERK_PUBLISHABLE_KEY" \
  "$variables"
assert_line "the deploy account variable names warden-deploy" \
  "gh variable set GCP_DEPLOY_SA --body warden-deploy@$project.iam.gserviceaccount.com"
assert_line "the connection variable names the instance" \
  "gh variable set CLOUD_SQL_CONNECTION --body $project:europe-west1:$instance"
assert_line "the publishable key is read from the keyring when the line is pasted, not by the script" \
  "gh variable set VITE_CLERK_PUBLISHABLE_KEY --body \"\$(secret-tool lookup service warden-clerk-publishable)\""
assert_no_line "no variable line names a password or a Clerk secret key" "password --body"

# Missing arguments: exit 1 with a usage line, before anything runs.
for args in "" "$project"; do
  set +e
  # shellcheck disable=SC2086 # the arguments split on purpose
  usage=$(DRY_RUN=1 "$setup" $args 2>&1)
  code=$?
  set -e
  assert_equal "with ${args:-no arguments}: exit 1" 1 "$code"
  assert_equal "with ${args:-no arguments}: a usage line and nothing else" \
    "usage: scripts/gcp-setup.sh <project-id> <instance>" "$usage"
done

# Outside DRY_RUN: no gcloud, or one that isn't signed in, stops it before any change.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
set +e
missing=$(PATH="$scratch/bin" "$BASH" "$setup" "$project" "$instance" 2>&1)
code=$?
set -e
assert_equal "without gcloud: exit 1" 1 "$code"
grep -qF "gcloud isn't on PATH" <<<"$missing" || fail "without gcloud: says so (got: $missing)"
pass "without gcloud: says so"

# A gcloud that lists no signed-in account, and records every call.
cat >"$scratch/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$(dirname "$0")/calls"
FAKE
chmod +x "$scratch/bin/gcloud"
set +e
signed_out=$(PATH="$scratch/bin:/usr/bin:/bin" "$setup" "$project" "$instance" 2>&1)
code=$?
set -e
assert_equal "signed out: exit 1" 1 "$code"
grep -qF "gcloud isn't signed in" <<<"$signed_out" || fail "signed out: says so (got: $signed_out)"
pass "signed out: says so"
assert_equal "signed out: gcloud was only asked who is signed in" \
  "auth list --filter=status:ACTIVE --format=value(account)" "$(cat "$scratch/bin/calls")"

# A real run against a fake gcloud that's signed in and finds nothing yet: the passwords reach `secrets create` on
# its stdin and nowhere else, and the policy written back has Secret Manager's reads logged.
mkdir "$scratch/real"
cat >"$scratch/real/gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf '%s\n' "$*" >>"$dir/calls"
case "$*" in
  "auth list"*) echo owner@example.com ;;
  "sql instances describe"*pointInTimeRecoveryEnabled*) echo False ;;
  "projects describe"*) echo 123456789 ;;
  "projects get-iam-policy"*) echo '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX="}' ;;
  "projects set-iam-policy"*) cp "$4" "$dir/policy" ;;
  "secrets create"*) cat >"$dir/secret-$3" ;;
  *describe*--format=*) echo "name: $3" ;;
  *describe*) exit 1 ;;
esac
FAKE
chmod +x "$scratch/real/gcloud"
real=$(PATH="$scratch/real:$PATH" "$setup" "$project" "$instance" 2>&1) || fail "real run failed: $real"
pass "a real run against the fake gcloud ends"
for secret in warden-db-app-password warden-db-migrate-password; do
  value=$(cat "$scratch/real/secret-$secret")
  [[ $value =~ ^[0-9a-f]{64}$ ]] || fail "$secret: the value piped in isn't 64 hex characters"
  pass "$secret: a 64-hex-character value is piped in"
  if grep -qF -- "$value" <<<"$real"; then fail "$secret: its value is in the output"; fi
  if grep -qF -- "$value" "$scratch/real/calls"; then fail "$secret: its value is in a command line"; fi
  pass "$secret: its value is in no output and no command line"
done
[[ $(cat "$scratch/real/secret-warden-db-app-password") != $(cat "$scratch/real/secret-warden-db-migrate-password") ]] ||
  fail "the two passwords are the same"
pass "the two passwords differ"
assert_equal "the policy written back keeps the bindings and etag, and logs Secret Manager's reads" \
  '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX=","auditConfigs":[{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"DATA_READ"}]}]}' \
  "$(cat "$scratch/real/policy")"
grep -qF "principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/attribute.repository_id/$repo_id" "$scratch/real/calls" ||
  fail "the pool binding doesn't name the project's number"
pass "the pool binding names the project's number"

# with_secret_reads_logged: the policy edit itself, on policies with and without audit configs.
# shellcheck source=../gcp-setup.sh
source "$setup"
merge() { with_secret_reads_logged <<<"$1"; }
assert_equal "an empty policy gains Secret Manager's DATA_READ only" \
  '{"auditConfigs":[{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"DATA_READ"}]}]}' \
  "$(merge '{}')"
assert_equal "bindings, etag and another service's config are kept as they are" \
  '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX=","version":1,"auditConfigs":[{"service":"cloudsql.googleapis.com","auditLogConfigs":[{"logType":"DATA_WRITE"}]},{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"DATA_READ"}]}]}' \
  "$(merge '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX=","version":1,"auditConfigs":[{"service":"cloudsql.googleapis.com","auditLogConfigs":[{"logType":"DATA_WRITE"}]}]}')"
assert_equal "Secret Manager's other log types are kept, and DATA_READ added" \
  '{"auditConfigs":[{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"ADMIN_READ"},{"logType":"DATA_READ"}]}]}' \
  "$(merge '{"auditConfigs":[{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"ADMIN_READ"}]}]}')"
already='{"auditConfigs":[{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"DATA_READ"}]}]}'
assert_equal "a policy that already has it is unchanged" "$already" "$(merge "$already")"

echo "gcp-setup: all passed"
