#!/usr/bin/env bash
# The Google Cloud setup script: its dry run (asserting on the gcloud commands it prints), then real runs against a
# fake gcloud, a stub cloud-sql-proxy and a node that stubs only the roles script, so nothing reaches Google or a
# database and no credentials are needed. Stops at the first failed assertion, exiting 1.
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
real_node=$(command -v node)

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

# line_of <fixed string>: the number of the first line of the dry run's output that is exactly it; fails when none is.
line_of() {
  local found
  found=$(grep -nxF -- "$1" <<<"$output") || fail "no line is exactly: $1"
  head -1 <<<"$found" | cut -d: -f1
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

assert_equal "warden-migrate gets Cloud SQL client and the app and migrate passwords, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-db-app-password roles/secretmanager.secretAccessor
secrets warden-db-migrate-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-migrate)"

assert_equal "warden-deploy gets run.developer, the warden repository's writer, and acts as run, migrate and daily only" \
  "artifacts warden roles/artifactregistry.writer
iam warden-daily@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
iam warden-migrate@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
iam warden-run@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
projects $project roles/run.developer" \
  "$(bindings_to warden-deploy)"

assert_equal "warden-daily gets Cloud SQL client and the app and admin passwords, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-db-admin-password roles/secretmanager.secretAccessor
secrets warden-db-app-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-daily)"
assert_line "it makes the warden-daily service account" \
  "gcloud iam service-accounts create warden-daily '--display-name=Warden: warden-daily' --project=$project"
assert_equal "only warden-daily reads the admin password" \
  "--member=serviceAccount:warden-daily@$project.iam.gserviceaccount.com" \
  "$(grep -F 'add-iam-policy-binding warden-db-admin-password' <<<"$output" | grep -o -- '--member=[^ ]*')"

assert_equal "warden-preview-run gets Cloud SQL client, the preview app password and the two Clerk secrets, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-clerk-jwt-key roles/secretmanager.secretAccessor
secrets warden-clerk-secret roles/secretmanager.secretAccessor
secrets warden-db-preview-app-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-preview-run)"

assert_equal "warden-preview-migrate gets Cloud SQL client and the preview migrate password, nothing else" \
  "projects $project roles/cloudsql.client
secrets warden-db-preview-migrate-password roles/secretmanager.secretAccessor" \
  "$(bindings_to warden-preview-migrate)"

# No project-level role, nothing on the live accounts, service or repository, and no secret.
assert_equal "warden-preview-deploy gets run.developer on the preview service and job, the preview repository's writer, and acts as the preview accounts only" \
  "artifacts warden-preview roles/artifactregistry.writer
iam warden-preview-migrate@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
iam warden-preview-run@$project.iam.gserviceaccount.com roles/iam.serviceAccountUser
run warden-migrate-preview roles/run.developer
run warden-preview roles/run.developer" \
  "$(bindings_to warden-preview-deploy)"
assert_line "warden-preview-deploy's run.developer is on the warden-preview service" \
  "gcloud run services add-iam-policy-binding warden-preview --region=europe-west1 --member=serviceAccount:warden-preview-deploy@$project.iam.gserviceaccount.com --role=roles/run.developer"
assert_line "warden-preview-deploy's run.developer is on the warden-migrate-preview job" \
  "gcloud run jobs add-iam-policy-binding warden-migrate-preview --region=europe-west1 --member=serviceAccount:warden-preview-deploy@$project.iam.gserviceaccount.com --role=roles/run.developer"

assert_no_line "no service account gets the postgres password" "add-iam-policy-binding warden-db-password"
for account in warden-run warden-migrate; do
  assert_no_line "$account gets no preview secret" "preview" "$(bindings_to "$account")"
done

assert_line "the repository binding is on the warden repository in europe-west1" \
  "gcloud artifacts repositories add-iam-policy-binding warden --location=europe-west1"

assert_no_line "no service account key is made" "keys create"

# The Workload Identity provider: the repository by its numeric id, pushed or dispatched, on main or preview/* only.
provider=$(grep -F 'providers create-oidc' <<<"$output")
assert_equal "the provider admits only the repository's pushes and dispatches on main and preview/*" \
  "'--attribute-condition=assertion.repository_id == \"$repo_id\" && assertion.event_name in [\"push\", \"workflow_dispatch\"] && (assertion.ref == \"refs/heads/main\" || assertion.ref.startsWith(\"refs/heads/preview/\"))'" \
  "$(grep -o "'--attribute-condition=[^']*'" <<<"$provider" || true)"
# google.subject may be at most 127 characters: the run, not the branch, whose name has no such bound.
# attribute.deploy carries the repository id beside the branch kind, so a token from another repository (through
# another provider in the pool) can never match a binding.
assert_equal "the subject is the repository and the run, and the mapping carries the repository and branch kind" \
  "'--attribute-mapping=google.subject=assertion.repository_id + \":\" + assertion.run_id + \":\" + assertion.run_attempt,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.deploy=assertion.repository_id + \":\" + (assertion.ref == \"refs/heads/main\" ? \"main\" : (assertion.ref.startsWith(\"refs/heads/preview/\") ? \"preview\" : \"other\"))'" \
  "$(grep -o "'--attribute-mapping=[^']*'" <<<"$provider" || true)"
pool_set="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github"
assert_equal "only this repository's main tokens may act as warden-deploy, and only its preview/* tokens as warden-preview-deploy" \
  "warden-deploy@$project.iam.gserviceaccount.com --member=$pool_set/attribute.deploy/$repo_id:main
warden-preview-deploy@$project.iam.gserviceaccount.com --member=$pool_set/attribute.deploy/$repo_id:preview" \
  "$(grep -F 'roles/iam.workloadIdentityUser' <<<"$output" | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i == "add-iam-policy-binding") account = $(i + 1)
      if ($i ~ /^--member=/) member = $i
    }
    print account, member
  }' | sort)"
assert_no_line "no binding admits the whole repository" "attribute.repository_id/"
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

generated="warden-db-app-password warden-db-migrate-password warden-db-preview-app-password warden-db-preview-migrate-password warden-db-admin-password"
for secret in $generated; do
  assert_line "$secret is made from a random value piped in, in europe-west1 only" \
    "<random value> | gcloud secrets create $secret --replication-policy=user-managed --locations=europe-west1 --data-file=- --project=$project"
done
for secret in warden-db-password warden-clerk-secret warden-clerk-publishable warden-clerk-jwt-key $generated; do
  assert_line "$secret's replication is printed" \
    "gcloud secrets describe $secret '--format=yaml(name,replication)' --project=$project"
done

# The roles step: from this machine, as postgres, through the proxy, once per set on its own database.
assert_line "the roles step starts the Cloud SQL Auth Proxy on a free local port" \
  "cloud-sql-proxy --quiet --address=127.0.0.1 --port=LOCAL_PORT $project:europe-west1:$instance &"
assert_line "the live roles run on warden as postgres, with placeholders for the passwords, the admin one included" \
  "WARDEN_DATABASE_ROLES=live PGHOST=127.0.0.1 PGPORT=LOCAL_PORT PGUSER=postgres PGDATABASE=warden PGPASSWORD=<from warden-db-password> WARDEN_APP_PASSWORD=<from warden-db-app-password> WARDEN_MIGRATE_PASSWORD=<from warden-db-migrate-password> WARDEN_ADMIN_PASSWORD=<from warden-db-admin-password> node server/src/roles.ts"
assert_line "the preview roles run on warden_preview as postgres, with the preview passwords' placeholders and no admin password" \
  "WARDEN_DATABASE_ROLES=preview PGHOST=127.0.0.1 PGPORT=LOCAL_PORT PGUSER=postgres PGDATABASE=warden_preview PGPASSWORD=<from warden-db-password> WARDEN_APP_PASSWORD=<from warden-db-preview-app-password> WARDEN_MIGRATE_PASSWORD=<from warden-db-preview-migrate-password> node server/src/roles.ts"

assert_line "it makes the warden-preview repository in europe-west1" \
  "gcloud artifacts repositories create warden-preview --repository-format=docker --location=europe-west1 --project=$project"
assert_line "the service runs as warden-run, public, at most 2 instances" \
  "gcloud run deploy warden --image=us-docker.pkg.dev/cloudrun/container/hello --region=europe-west1 --service-account=warden-run@$project.iam.gserviceaccount.com --allow-unauthenticated --max-instances=2 --project=$project"
assert_line "the preview service runs as warden-preview-run, public, at most 1 instance" \
  "gcloud run deploy warden-preview --image=us-docker.pkg.dev/cloudrun/container/hello --region=europe-west1 --service-account=warden-preview-run@$project.iam.gserviceaccount.com --allow-unauthenticated --max-instances=1 --project=$project"
assert_line "the preview migration job runs as warden-preview-migrate, with Google's placeholder job image" \
  "gcloud run jobs create warden-migrate-preview --image=us-docker.pkg.dev/cloudrun/container/job:latest --region=europe-west1 --service-account=warden-preview-migrate@$project.iam.gserviceaccount.com --project=$project"

# The daily Job and its Cloud Scheduler trigger (ADR 0009): Scheduler runs as warden-scheduler, which may start that
# one Job and nothing else.
assert_equal "the APIs turned on include Cloud Scheduler's" \
  "gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com iam.googleapis.com sts.googleapis.com iamcredentials.googleapis.com cloudscheduler.googleapis.com --project=$project" \
  "$(grep -F 'gcloud services enable' <<<"$output")"
assert_line "it makes the warden-scheduler service account" \
  "gcloud iam service-accounts create warden-scheduler '--display-name=Warden: warden-scheduler' --project=$project"
assert_equal "warden-scheduler may start warden-daily-expiry, nothing else" \
  "run warden-daily-expiry roles/run.invoker" \
  "$(bindings_to warden-scheduler)"
assert_no_line "no one may act as warden-scheduler" \
  "gcloud iam service-accounts add-iam-policy-binding warden-scheduler@"
daily_job="gcloud run jobs create warden-daily-expiry --image=us-docker.pkg.dev/cloudrun/container/job:latest --region=europe-west1 --service-account=warden-daily@$project.iam.gserviceaccount.com --project=$project"
assert_line "the daily Job runs as warden-daily, with Google's placeholder job image, in europe-west1" "$daily_job"
daily_binding="gcloud run jobs add-iam-policy-binding warden-daily-expiry --region=europe-west1 --member=serviceAccount:warden-scheduler@$project.iam.gserviceaccount.com --role=roles/run.invoker --project=$project"
assert_equal "the daily Job's one binding is warden-scheduler's run.invoker" "$daily_binding" \
  "$(grep -F 'add-iam-policy-binding warden-daily-expiry' <<<"$output")"
daily_trigger="gcloud scheduler jobs create http warden-daily-expiry --location=europe-west1 '--schedule=0 4 * * *' --time-zone=Etc/UTC --uri=https://run.googleapis.com/v2/projects/$project/locations/europe-west1/jobs/warden-daily-expiry:run --http-method=POST --oauth-service-account-email=warden-scheduler@$project.iam.gserviceaccount.com --project=$project"
assert_line "the Scheduler job POSTs to the daily Job's :run daily at 04:00 UTC, with an OAuth token as warden-scheduler" \
  "$daily_trigger"
# Assigned one at a time, so a line_of that fails stops the test (set -e) rather than comparing an empty number.
job_line=$(line_of "$daily_job")
binding_line=$(line_of "$daily_binding")
trigger_line=$(line_of "$daily_trigger")
[[ $job_line -lt $binding_line && $binding_line -lt $trigger_line ]] ||
  fail "the Scheduler job isn't printed after the daily Job and its binding"
pass "the Scheduler job is printed after the daily Job and its binding"

variables=$(grep -E '^gh variable set' <<<"$output" | awk '{ print $4 }' | sort)
assert_equal "a gh variable line for each of the six variables" \
  "CLOUD_SQL_CONNECTION
GCP_DEPLOY_SA
GCP_PREVIEW_DEPLOY_SA
GCP_PROJECT_ID
GCP_WIF_PROVIDER
VITE_CLERK_PUBLISHABLE_KEY" \
  "$variables"
assert_line "the deploy account variable names warden-deploy" \
  "gh variable set GCP_DEPLOY_SA --body warden-deploy@$project.iam.gserviceaccount.com --repo $repo"
assert_line "the preview deploy account variable names warden-preview-deploy" \
  "gh variable set GCP_PREVIEW_DEPLOY_SA --body warden-preview-deploy@$project.iam.gserviceaccount.com --repo $repo"
assert_line "the connection variable names the instance" \
  "gh variable set CLOUD_SQL_CONNECTION --body $project:europe-west1:$instance --repo $repo"
assert_line "the publishable key is read from the keyring when the line is pasted, not by the script" \
  "gh variable set VITE_CLERK_PUBLISHABLE_KEY --body \"\$(secret-tool lookup service warden-clerk-publishable)\" --repo $repo"
assert_no_line "no variable line names a password or a Clerk secret key" "password --body"

# bash 3.2 (macOS) calls an empty array unbound under set -u: every array expansion is guarded.
assert_equal "no array is expanded without the \${a[@]+\"\${a[@]}\"} guard" "" \
  "$(grep -nE '"\$\{[A-Za-z_]+\[@\]\}"' "$setup" | grep -vE '\$\{([A-Za-z_]+)\[@\]\+"\$\{\1\[@\]\}"\}' || true)"

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

# DRY_RUN is 1 or 0 (or unset or empty): anything else stops before any gcloud call.
for value in true yes; do
  : >"$scratch/bin/calls"
  capture setup_with DRY_RUN="$value" PATH="$scratch/bin:/usr/bin:/bin" "$setup" "$project" "$instance"
  assert_equal "DRY_RUN=$value: exit 1" 1 "$code"
  assert_line "DRY_RUN=$value: names the allowed values" "DRY_RUN must be 1 (a dry run) or 0 (a real run" "$out"
  assert_equal "DRY_RUN=$value: no gcloud call" "" "$(cat "$scratch/bin/calls")"
done

# A fake gcloud that's signed in, records every call, and finds what FAKE_STATE says:
#   fresh       the instance and the four hand-made secrets only, as on a first run
#   rerun       everything, with point-in-time recovery on
#   unprepared  neither the instance nor warden-clerk-jwt-key
#   denied      every secret refuses with PERMISSION_DENIED
#   no-adc      as fresh, but with no application-default credentials
# Each describe that finds nothing fails the way that gcloud command does. A secret's value is what was piped into
# `secrets create`, or fake-<name> for one made by hand.
cat >"$scratch/fake-gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf '%s\n' "$*" >>"$dir/calls"
not_found() { echo "ERROR: (gcloud.$1) $2" >&2; exit 1; }
case "$*" in
  "auth list"*) echo owner@example.com ;;
  "auth application-default print-access-token"*)
    [[ $FAKE_STATE == no-adc ]] && { echo "ERROR: (gcloud.auth.application-default.print-access-token) no credentials" >&2; exit 1; }
    echo fake-token ;;
  "sql instances describe"*pointInTimeRecoveryEnabled*)
    if [[ $FAKE_STATE == rerun ]]; then echo True; else echo False; fi ;;
  "projects describe"*) echo 123456789 ;;
  "projects get-iam-policy"*) echo '{"bindings":[{"role":"roles/owner","members":["user:a@example.com"]}],"etag":"BwX="}' ;;
  "projects set-iam-policy"*) cp "$4" "$dir/policy" ;;
  "secrets create"*) cat >"$dir/secret-$3" ;;
  "secrets versions access"*)
    for arg in "$@"; do [[ $arg == --secret=* ]] && name=${arg#--secret=}; done
    if [[ -f $dir/secret-$name ]]; then cat "$dir/secret-$name"; else printf 'fake-%s' "$name"; fi ;;
  *describe*--format=*) echo "name: $3" ;;
  "secrets describe"*)
    [[ $FAKE_STATE == denied ]] && not_found secrets.describe "PERMISSION_DENIED: Permission denied on secret $3."
    [[ $FAKE_STATE == rerun ]] && exit 0
    case "$3" in
      warden-db-password | warden-clerk-secret | warden-clerk-publishable) exit 0 ;;
      warden-clerk-jwt-key) [[ $FAKE_STATE != unprepared ]] && exit 0 ;;
    esac
    not_found secrets.describe "NOT_FOUND: Secret [projects/1/secrets/$3] not found or has no versions." ;;
  "sql instances describe"*)
    [[ $FAKE_STATE == unprepared ]] &&
      not_found sql.instances.describe "There was no instance found at projects/p/instances/$4 or you are not authorized to access it."
    exit 0 ;;
  *describe*) [[ $FAKE_STATE == rerun ]] && exit 0 ;;&
  "sql databases describe"*) not_found sql.databases.describe "HTTPError 404: Not Found" ;;
  "run services describe"*) not_found run.services.describe "Cannot find service [$4]" ;;
  "run jobs describe"*) not_found run.jobs.describe "Cannot find job [$4]." ;;
  *describe*) not_found describe "NOT_FOUND: Requested entity was not found." ;;
esac
exit 0
FAKE
chmod +x "$scratch/fake-gcloud"

# A Cloud SQL Auth Proxy that listens on the port it's given (so the script's wait for it ends), and records its pid
# and arguments. FAKE_PROXY=fail makes it exit at once as on a port another process holds; fail-once, only the first
# time.
cat >"$scratch/fake-proxy" <<FAKE
#!/usr/bin/env bash
dir=\$(dirname "\$0")
echo "\$\$" >"\$dir/proxy-pid"
printf '%s\n' "\$*" >>"\$dir/proxy-calls"
for arg in "\$@"; do [[ \$arg == --port=* ]] && port=\${arg#--port=}; done
if [[ \${FAKE_PROXY-} == fail || ( \${FAKE_PROXY-} == fail-once && ! -f \$dir/proxy-failed ) ]]; then
  touch "\$dir/proxy-failed"
  echo "listen tcp 127.0.0.1:\$port: bind: address already in use" >&2
  exit 1
fi
PORT=\$port exec "$real_node" -e 'require("node:net").createServer((s) => s.end()).listen(Number(process.env.PORT), "127.0.0.1")'
FAKE
chmod +x "$scratch/fake-proxy"

# A node that stands in for the roles script only, recording the set, the database and where it connects, and the
# passwords it was given (one per line), and exiting FAKE_ROLES_EXIT. With FAKE_FREE_PORT, the script's free-port
# lookup gets that port. Anything else goes to the real node.
cat >"$scratch/fake-node" <<FAKE
#!/usr/bin/env bash
if [[ -n \${FAKE_FREE_PORT-} && \${1-} == -e && \${2-} == *'listen(0'* ]]; then
  printf '%s' "\$FAKE_FREE_PORT"
  exit 0
fi
if [[ \${1-} == */server/src/roles.ts ]]; then
  dir=\$(dirname "\$0")
  printf '%s %s %s %s:%s\n' "\$WARDEN_DATABASE_ROLES" "\$PGDATABASE" "\$PGUSER" "\$PGHOST" "\$PGPORT" >>"\$dir/roles-runs"
  printf '%s\n' "\$PGPASSWORD" "\$WARDEN_APP_PASSWORD" "\$WARDEN_MIGRATE_PASSWORD" "admin:\${WARDEN_ADMIN_PASSWORD-}" >>"\$dir/roles-passwords"
  [[ \${FAKE_ROLES_EXIT:-0} == 0 ]] || echo '{"severity":"ERROR","message":"creating the roles failed"}'
  exit "\${FAKE_ROLES_EXIT:-0}"
fi
exec "$real_node" "\$@"
FAKE
chmod +x "$scratch/fake-node"

env PATH=/usr/bin:/bin bash -c 'command -v cloud-sql-proxy' >/dev/null &&
  fail "a cloud-sql-proxy in /usr/bin or /bin would stand in for the stub"

# real_run <name> <state> [VAR=value...]: a real run against the fakes in that state, in its own folder, with only
# the fakes and /usr/bin and /bin on PATH; its gcloud calls are in $calls. WITHOUT names a fake to leave out, and
# SETUP_SCRIPT another copy of the script.
real_run() {
  local name=$1 state=$2
  shift 2
  local dir="$scratch/$name"
  mkdir "$dir"
  cp "$scratch/fake-gcloud" "$dir/gcloud"
  [[ ${WITHOUT-} == proxy ]] || cp "$scratch/fake-proxy" "$dir/cloud-sql-proxy"
  cp "$scratch/fake-node" "$dir/node"
  touch "$dir/calls"
  capture setup_with FAKE_STATE="$state" PATH="$dir:/usr/bin:/bin" "$@" "${SETUP_SCRIPT:-$setup}" "$project" "$instance"
  calls=$(cat "$dir/calls")
}
# A call that changes something: anything but signing in and reading.
changes() { grep -vE '^auth |describe|get-iam-policy|versions access' <<<"$calls" || true; }

real_run unprepared unprepared
assert_equal "before the instance and the hand-made secrets exist: exit 1" 1 "$code"
assert_line "it names the missing instance" "Cloud SQL instance $instance" "$out"
assert_line "it names the missing secret" "secret warden-clerk-jwt-key" "$out"
assert_no_line "it names no secret that exists" "secret warden-clerk-secret" "$out"
assert_equal "it changes nothing" "" "$(changes)"

real_run denied denied
assert_equal "a describe refused for another reason than not found: exit 1" 1 "$code"
assert_line "it prints gcloud's error" "PERMISSION_DENIED: Permission denied on secret" "$out"
assert_equal "it changes nothing" "" "$(changes)"

# What the roles step needs, each checked before any change.
WITHOUT=proxy real_run no-proxy fresh
assert_equal "without cloud-sql-proxy: exit 1" 1 "$code"
assert_line "without cloud-sql-proxy: says so" "cloud-sql-proxy isn't on PATH" "$out"
assert_equal "without cloud-sql-proxy: it changes nothing" "" "$(changes)"

real_run no-adc no-adc
assert_equal "without application-default credentials: exit 1" 1 "$code"
assert_line "without application-default credentials: says so" "gcloud auth application-default login" "$out"
assert_equal "without application-default credentials: it changes nothing" "" "$(changes)"

# A copy of the script in a tree with no server dependencies installed.
mkdir -p "$scratch/tree/scripts"
cp "$setup" "$scratch/tree/scripts/gcp-setup.sh"
SETUP_SCRIPT="$scratch/tree/scripts/gcp-setup.sh" real_run no-deps fresh
assert_equal "without the server's dependencies: exit 1" 1 "$code"
assert_line "without the server's dependencies: says so" "pnpm install" "$out"
assert_equal "without the server's dependencies: it changes nothing" "" "$(changes)"

# A first run: the passwords reach `secrets create` on its stdin, and the roles script's environment, and nowhere
# else.
real_run fresh fresh
[[ $code == 0 ]] || fail "a first run against the fake gcloud failed: $out"
pass "a first run against the fake gcloud ends"
for secret in $generated; do
  value=$(cat "$scratch/fresh/secret-$secret")
  [[ $value =~ ^[0-9a-f]{64}$ ]] || fail "$secret: the value piped in isn't 64 hex characters"
  pass "$secret: a 64-hex-character value is piped in"
  assert_no_line "$secret: its value isn't in the output" "$value" "$out"
  assert_no_line "$secret: its value isn't on a command line" "$value" "$calls"
done
[[ $(sort "$scratch"/fresh/secret-* | uniq -d) == "" ]] || fail "two of the passwords are the same"
pass "the five passwords differ"
assert_equal "the roles script runs twice, as postgres through the proxy: live on warden, then preview on warden_preview" \
  "live warden postgres 127.0.0.1:$(cut -d= -f2 <<<"$(grep -o -- '--port=[0-9]*' "$scratch/fresh/proxy-calls")")
preview warden_preview postgres 127.0.0.1:$(cut -d= -f2 <<<"$(grep -o -- '--port=[0-9]*' "$scratch/fresh/proxy-calls")")" \
  "$(cat "$scratch/fresh/roles-runs")"
assert_equal "each run gets the postgres password and its own set's passwords: the admin one for live only" \
  "fake-warden-db-password
$(cat "$scratch/fresh/secret-warden-db-app-password")
$(cat "$scratch/fresh/secret-warden-db-migrate-password")
admin:$(cat "$scratch/fresh/secret-warden-db-admin-password")
fake-warden-db-password
$(cat "$scratch/fresh/secret-warden-db-preview-app-password")
$(cat "$scratch/fresh/secret-warden-db-preview-migrate-password")
admin:" \
  "$(cat "$scratch/fresh/roles-passwords")"
assert_no_line "the postgres password isn't in the output" "fake-warden-db-password" "$out"
assert_line "the proxy connects to the instance" "$project:europe-west1:$instance" "$(cat "$scratch/fresh/proxy-calls")"
if kill -0 "$(cat "$scratch/fresh/proxy-pid")" 2>/dev/null; then fail "the proxy is still running after the run"; fi
pass "the proxy is stopped after the run"
policy=$(cat "$scratch/fresh/policy")
assert_line "the policy written back logs Secret Manager's reads" '"logType":"DATA_READ"' "$policy"
assert_line "the policy written back keeps the etag it was read with" '"etag":"BwX="' "$policy"
assert_line "warden-deploy's pool binding names the project's number" \
  "principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/attribute.deploy/$repo_id:main" \
  "$calls"
assert_line "a first run makes the service" "run deploy warden " "$calls"
assert_line "a first run makes the preview service" "run deploy warden-preview " "$calls"
assert_line "a first run makes the preview migration job" "run jobs create warden-migrate-preview " "$calls"
assert_line "a first run makes the daily Job" "run jobs create warden-daily-expiry " "$calls"
assert_line "a first run makes the daily Job's Scheduler job" "scheduler jobs create http warden-daily-expiry " "$calls"

# An empty DRY_RUN is a real run too.
real_run empty-dry-run fresh DRY_RUN=
[[ $code == 0 ]] || fail "a real run with DRY_RUN empty failed: $out"
assert_line "DRY_RUN empty: a real run" "run deploy warden " "$calls"

# A failing roles run stops the script with its exit code and the roles script's error, and the proxy is stopped.
real_run roles-fail fresh FAKE_ROLES_EXIT=3
assert_equal "a failing roles run: the script exits with its code" 3 "$code"
assert_line "a failing roles run: the roles script's error is shown" "creating the roles failed" "$out"
assert_line "a failing roles run: the script says which run failed" "the roles step failed for the live set on warden" "$out"
assert_no_line "a failing roles run: nothing after it runs" "service-accounts create" "$calls"
[[ -s $scratch/roles-fail/proxy-pid ]] || fail "a failing roles run: the proxy never started"
if kill -0 "$(cat "$scratch/roles-fail/proxy-pid")" 2>/dev/null; then fail "a failing roles run: the proxy is still running"; fi
pass "a failing roles run: the proxy is stopped"

# A proxy that can't bind its port, which another process holds: the script never takes that process for the proxy,
# so no password is sent to it. It tries once more on a fresh port, then stops.
"$real_node" -e 'const s = require("node:net").createServer((c) => c.end());
  s.listen(0, "127.0.0.1", () => console.log(s.address().port));' >"$scratch/squatter-port" &
squatter=$!
# set -e holds inside the trap too: a kill of a squatter already stopped (below) must not end the trap with status 1.
trap 'kill "$squatter" 2>/dev/null || true; rm -rf "$scratch"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -s $scratch/squatter-port ]] && break; sleep 0.2; done
squatted=$(cat "$scratch/squatter-port")
[[ $squatted =~ ^[0-9]+$ ]] || fail "the squatter didn't report its port"
real_run port-taken fresh FAKE_PROXY=fail FAKE_FREE_PORT="$squatted"
kill "$squatter" 2>/dev/null || true
assert_equal "a proxy that can't bind: the script exits 1" 1 "$code"
assert_line "a proxy that can't bind: it says the proxy stopped" "the Cloud SQL Auth Proxy stopped before it was ready" "$out"
[[ ! -e $scratch/port-taken/roles-runs ]] || fail "a proxy that can't bind: the roles script ran against another process"
pass "a proxy that can't bind: no roles run, so no password is sent to the process holding the port"
assert_equal "a proxy that can't bind: it's tried twice" 2 "$(wc -l <"$scratch/port-taken/proxy-calls" | tr -d ' ')"

# A proxy that fails to bind once: the script retries on a fresh port, and the roles run there.
real_run proxy-retry fresh FAKE_PROXY=fail-once
[[ $code == 0 ]] || fail "a proxy that fails once: the run failed: $out"
ports=$(grep -o -- '--port=[0-9]*' "$scratch/proxy-retry/proxy-calls" | cut -d= -f2)
assert_equal "a proxy that fails once: it's started twice" 2 "$(wc -l <<<"$ports" | tr -d ' ')"
assert_equal "a proxy that fails once: the roles connect to the second proxy's port" \
  "127.0.0.1:$(tail -1 <<<"$ports")
127.0.0.1:$(tail -1 <<<"$ports")" \
  "$(cut -d' ' -f4 "$scratch/proxy-retry/roles-runs")"

# A rerun: nothing is made again, and each setting is put back.
real_run rerun rerun
[[ $code == 0 ]] || fail "a rerun against the fake gcloud failed: $out"
pass "a rerun against the fake gcloud ends"
for made in "secrets create" "sql databases create" "service-accounts create" "workload-identity-pools create" \
  "providers create-oidc" "run deploy" "run jobs create" "scheduler jobs create" "repositories create" \
  "--enable-point-in-time-recovery"; do
  assert_no_line "a rerun doesn't run $made" "$made" "$calls"
done
assert_line "a rerun with point-in-time recovery on still sets the backups, without the recovery flag" \
  "sql instances patch $instance --backup-start-time=03:00 --retained-backups-count=7 --retained-transaction-log-days=6 --project=$project" \
  "$calls"
assert_line "a rerun puts the provider's condition back" \
  "iam workload-identity-pools providers update-oidc warden" "$calls"
assert_line "a rerun puts the service's account and instance limit back" \
  "run services update warden --region=europe-west1 --service-account=warden-run@$project.iam.gserviceaccount.com --max-instances=2 --project=$project" \
  "$calls"
assert_line "a rerun keeps the service public" \
  "run services add-iam-policy-binding warden --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=$project" \
  "$calls"
assert_line "a rerun puts the preview service's account and instance limit back" \
  "run services update warden-preview --region=europe-west1 --service-account=warden-preview-run@$project.iam.gserviceaccount.com --max-instances=1 --project=$project" \
  "$calls"
assert_line "a rerun keeps the preview service public" \
  "run services add-iam-policy-binding warden-preview --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=$project" \
  "$calls"
assert_line "a rerun puts the preview job's account back" \
  "run jobs update warden-migrate-preview --region=europe-west1 --service-account=warden-preview-migrate@$project.iam.gserviceaccount.com --project=$project" \
  "$calls"
assert_line "a rerun puts the daily Job's account back" \
  "run jobs update warden-daily-expiry --region=europe-west1 --service-account=warden-daily@$project.iam.gserviceaccount.com --project=$project" \
  "$calls"
assert_no_line "a rerun keeps each job's image" "--image=" "$(grep -F 'run jobs update' <<<"$calls")"
assert_line "a rerun puts the daily Job's Scheduler job back" \
  "scheduler jobs update http warden-daily-expiry --location=europe-west1 --schedule=0 4 * * * --time-zone=Etc/UTC --uri=https://run.googleapis.com/v2/projects/$project/locations/europe-west1/jobs/warden-daily-expiry:run --http-method=POST --oauth-service-account-email=warden-scheduler@$project.iam.gserviceaccount.com --project=$project" \
  "$calls"
assert_equal "a rerun runs the roles script for both sets again" \
  "live warden
preview warden_preview" \
  "$(cut -d' ' -f1,2 "$scratch/rerun/roles-runs")"

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
