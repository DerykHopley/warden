#!/usr/bin/env bash
# The Google Cloud setup script: its dry run (asserting on the gcloud commands it prints), then real runs against a
# fake gcloud, so nothing reaches Google and no credentials are needed. Stops at the first failed assertion, exiting 1.
# Run from anywhere: scripts/test/gcp-setup.test.sh
set -euo pipefail

# Only what each case sets reaches the script.
unset DRY_RUN WARDEN_GITHUB_REPO WARDEN_GITHUB_REPO_ID

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
setup="$root/scripts/gcp-setup.sh"
project=test-project
instance=test-db
repo=example-owner/example-repo
repo_id=987654321
usage="usage: [DRY_RUN=1] scripts/gcp-setup.sh <project-id> <instance>"

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

# assert_line <what> <fixed string> [text]: some line of the text (the dry run's output by default) contains it.
assert_line() {
  grep -qF -- "$2" <<<"${3-$output}" || fail "$1: no line contains: $2"
  pass "$1"
}

# assert_no_line <what> <fixed string> [text]
assert_no_line() {
  if grep -qF -- "$2" <<<"${3-$output}"; then fail "$1: a line contains: $2"; fi
  pass "$1"
}

# capture <command...>: its output (stdout and stderr) in $out, its exit code in $code.
capture() {
  set +e
  out=$("$@" 2>&1)
  code=$?
  set -e
}

# The setup script with the repository variables set, plus any VAR=value given before the arguments.
setup_with() { env WARDEN_GITHUB_REPO="$repo" WARDEN_GITHUB_REPO_ID="$repo_id" "$@"; }

output=$(setup_with DRY_RUN=1 "$setup" "$project" "$instance")

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

# The Workload Identity provider: the repository by its numeric id, pushed or dispatched, on main or preview/* only.
provider=$(grep -F 'providers create-oidc' <<<"$output")
assert_equal "the provider admits only the repository's pushes and dispatches on main and preview/*" \
  "'--attribute-condition=assertion.repository_id == \"$repo_id\" && assertion.event_name in [\"push\", \"workflow_dispatch\"] && (assertion.ref == \"refs/heads/main\" || assertion.ref.startsWith(\"refs/heads/preview/\"))'" \
  "$(grep -o "'--attribute-condition=[^']*'" <<<"$provider" || true)"
# google.subject may be at most 127 characters: the run, not the branch, whose name has no such bound.
assert_equal "the subject is the repository and the run, and ref and repository_id stay attributes" \
  "'--attribute-mapping=google.subject=assertion.repository_id + \":\" + assertion.run_id + \":\" + assertion.run_attempt,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name'" \
  "$(grep -o "'--attribute-mapping=[^']*'" <<<"$provider" || true)"
assert_line "the pool may act as warden-deploy, for this repository only" \
  "--role=roles/iam.workloadIdentityUser --member=principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$repo_id"
assert_line "the repository is named from WARDEN_GITHUB_REPO" "# GitHub repository: $repo (id $repo_id)"

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
  "gh variable set GCP_DEPLOY_SA --body warden-deploy@$project.iam.gserviceaccount.com --repo $repo"
assert_line "the connection variable names the instance" \
  "gh variable set CLOUD_SQL_CONNECTION --body $project:europe-west1:$instance --repo $repo"
assert_line "the publishable key is read from the keyring when the line is pasted, not by the script" \
  "gh variable set VITE_CLERK_PUBLISHABLE_KEY --body \"\$(secret-tool lookup service warden-clerk-publishable)\" --repo $repo"
assert_no_line "no variable line names a password or a Clerk secret key" "password --body"

# Missing arguments: exit 1 with a usage line, before anything runs.
check_usage() {
  local label=$1
  shift
  capture setup_with DRY_RUN=1 "$setup" "$@"
  assert_equal "$label: exit 1" 1 "$code"
  assert_equal "$label: a usage line and nothing else" "$usage" "$out"
}
check_usage "with no arguments"
check_usage "with only the project" "$project"

# The repository that may deploy: both variables, the id numeric, before anything runs.
check_repository() {
  local label=$1 message=$2
  shift 2
  capture env DRY_RUN=1 "$@" "$setup" "$project" "$instance"
  assert_equal "$label: exit 1" 1 "$code"
  assert_line "$label: says so" "$message" "$out"
  assert_no_line "$label: prints no command" "gcloud " "$out"
}
check_repository "without WARDEN_GITHUB_REPO" "set WARDEN_GITHUB_REPO" WARDEN_GITHUB_REPO_ID="$repo_id"
check_repository "without WARDEN_GITHUB_REPO_ID" "set WARDEN_GITHUB_REPO" WARDEN_GITHUB_REPO="$repo"
check_repository "with a repository id that isn't a number" "WARDEN_GITHUB_REPO_ID must be the repository's numeric id" \
  WARDEN_GITHUB_REPO="$repo" WARDEN_GITHUB_REPO_ID=12ab

# Outside DRY_RUN=1: no gcloud, or one that isn't signed in, stops it before any change.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
capture env PATH="$scratch/bin" WARDEN_GITHUB_REPO="$repo" WARDEN_GITHUB_REPO_ID="$repo_id" \
  "$BASH" "$setup" "$project" "$instance"
assert_equal "without gcloud: exit 1" 1 "$code"
assert_line "without gcloud: says so" "gcloud isn't on PATH" "$out"

# A gcloud that lists no signed-in account, and records every call. DRY_RUN=0 is a real run.
cat >"$scratch/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$(dirname "$0")/calls"
FAKE
chmod +x "$scratch/bin/gcloud"
capture setup_with DRY_RUN=0 PATH="$scratch/bin:/usr/bin:/bin" "$setup" "$project" "$instance"
assert_equal "signed out: exit 1" 1 "$code"
assert_line "signed out: says so" "gcloud isn't signed in" "$out"
assert_equal "signed out: gcloud was only asked who is signed in" \
  "auth list --filter=status:ACTIVE --format=value(account)" "$(cat "$scratch/bin/calls")"

# A fake gcloud that's signed in, records every call, and finds what FAKE_STATE says:
#   fresh       the instance and the four hand-made secrets only, as on a first run
#   rerun       everything, with point-in-time recovery on
#   unprepared  neither the instance nor warden-clerk-jwt-key
#   denied      every secret refuses with PERMISSION_DENIED
# Each describe that finds nothing fails the way that gcloud command does.
cat >"$scratch/fake-gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf '%s\n' "$*" >>"$dir/calls"
not_found() { echo "ERROR: (gcloud.$1) $2" >&2; exit 1; }
case "$*" in
  "auth list"*) echo owner@example.com ;;
  "sql instances describe"*pointInTimeRecoveryEnabled*)
    if [[ $FAKE_STATE == rerun ]]; then echo True; else echo False; fi ;;
  "projects describe"*) echo 123456789 ;;
  "projects get-iam-policy"*) echo '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX="}' ;;
  "projects set-iam-policy"*) cp "$4" "$dir/policy" ;;
  "secrets create"*) cat >"$dir/secret-$3" ;;
  *describe*--format=*) echo "name: $3" ;;
  "secrets describe"*)
    [[ $FAKE_STATE == denied ]] && not_found secrets.describe "PERMISSION_DENIED: Permission denied on secret $3."
    [[ $FAKE_STATE == rerun ]] && exit 0
    case "$3" in
      warden-db-password | warden-clerk-secret | warden-clerk-publishable) exit 0 ;;
      warden-clerk-jwt-key) [[ $FAKE_STATE == fresh ]] && exit 0 ;;
    esac
    not_found secrets.describe "NOT_FOUND: Secret [projects/1/secrets/$3] not found or has no versions." ;;
  "sql instances describe"*)
    [[ $FAKE_STATE == unprepared ]] &&
      not_found sql.instances.describe "There was no instance found at projects/p/instances/$4 or you are not authorized to access it."
    exit 0 ;;
  *describe*) [[ $FAKE_STATE == rerun ]] && exit 0 ;;&
  "sql databases describe"*) not_found sql.databases.describe "HTTPError 404: Not Found" ;;
  "run services describe"*) not_found run.services.describe "Cannot find service [$4]" ;;
  *describe*) not_found describe "NOT_FOUND: Requested entity was not found." ;;
esac
exit 0
FAKE
chmod +x "$scratch/fake-gcloud"

# real_run <state>: a real run against the fake in that state; its calls are in $calls.
real_run() {
  local dir="$scratch/$1"
  mkdir "$dir"
  cp "$scratch/fake-gcloud" "$dir/gcloud"
  touch "$dir/calls"
  capture setup_with FAKE_STATE="$1" PATH="$dir:$PATH" "$setup" "$project" "$instance"
  calls=$(cat "$dir/calls")
}
# A call that changes something: anything but signing in and reading.
changes() { grep -vE '^auth list|describe|get-iam-policy' <<<"$calls" || true; }

real_run unprepared
assert_equal "before the instance and the hand-made secrets exist: exit 1" 1 "$code"
assert_line "it names the missing instance" "Cloud SQL instance $instance" "$out"
assert_line "it names the missing secret" "secret warden-clerk-jwt-key" "$out"
assert_no_line "it names no secret that exists" "secret warden-clerk-secret" "$out"
assert_equal "it changes nothing" "" "$(changes)"

real_run denied
assert_equal "a describe refused for another reason than not found: exit 1" 1 "$code"
assert_line "it prints gcloud's error" "PERMISSION_DENIED: Permission denied on secret" "$out"
assert_equal "it changes nothing" "" "$(changes)"

# A first run: the passwords reach `secrets create` on its stdin and nowhere else.
real_run fresh
[[ $code == 0 ]] || fail "a first run against the fake gcloud failed: $out"
pass "a first run against the fake gcloud ends"
for secret in warden-db-app-password warden-db-migrate-password; do
  value=$(cat "$scratch/fresh/secret-$secret")
  [[ $value =~ ^[0-9a-f]{64}$ ]] || fail "$secret: the value piped in isn't 64 hex characters"
  pass "$secret: a 64-hex-character value is piped in"
  assert_no_line "$secret: its value isn't in the output" "$value" "$out"
  assert_no_line "$secret: its value isn't on a command line" "$value" "$calls"
done
[[ $(cat "$scratch/fresh/secret-warden-db-app-password") != $(cat "$scratch/fresh/secret-warden-db-migrate-password") ]] ||
  fail "the two passwords are the same"
pass "the two passwords differ"
policy=$(cat "$scratch/fresh/policy")
assert_line "the policy written back logs Secret Manager's reads" '"logType":"DATA_READ"' "$policy"
assert_line "the policy written back keeps the etag it was read with" '"etag":"BwX="' "$policy"
assert_line "the pool binding names the project's number" \
  "principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/attribute.repository_id/$repo_id" \
  "$calls"
assert_line "a first run makes the service" "run deploy warden" "$calls"

# A rerun: nothing is made again, and each setting is put back.
real_run rerun
[[ $code == 0 ]] || fail "a rerun against the fake gcloud failed: $out"
pass "a rerun against the fake gcloud ends"
for made in "secrets create" "sql databases create" "service-accounts create" "workload-identity-pools create" \
  "providers create-oidc" "run deploy" "repositories create" "--enable-point-in-time-recovery"; do
  assert_no_line "a rerun doesn't run $made" "$made" "$calls"
done
assert_line "a rerun puts the provider's condition back" \
  "iam workload-identity-pools providers update-oidc warden" "$calls"
assert_line "a rerun puts the service's account and instance limit back" \
  "run services update warden --region=europe-west1 --service-account=warden-run@$project.iam.gserviceaccount.com --max-instances=2 --project=$project" \
  "$calls"
assert_line "a rerun keeps the service public" \
  "run services add-iam-policy-binding warden --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=$project" \
  "$calls"

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
