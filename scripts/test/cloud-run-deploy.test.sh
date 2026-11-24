#!/usr/bin/env bash
# The Cloud Run deploy script, preview mode: real runs against a stub gcloud and a stub curl, first on PATH, which
# record every call and answer as each case sets, so nothing reaches Google and no credentials are needed. Stops at
# the first failed assertion, exiting 1.
# Run from anywhere: scripts/test/cloud-run-deploy.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
deploy="$root/scripts/cloud-run-deploy.sh"
project=test-project
connection="$project:europe-west1:test-db"
image="europe-west1-docker.pkg.dev/$project/warden-preview/warden:abc1234def5678"
publishable=pk_test_Y2ktcGxhY2Vob2xkZXIuY2xlcmsuYWNjb3VudHMuZGV2JA
# The two URLs the stub reports for warden-preview: the deterministic one (status.url) and the older hash one.
url_new=https://warden-preview-123456789012.europe-west1.run.app
url_old=https://warden-preview-abcdefghij-ew.a.run.app

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

# assert_line <what> <fixed string> <text>: some line of the text contains it.
assert_line() {
  grep -qF -- "$2" <<<"$3" || fail "$1: no line contains: $2"$'\n'"--- in"$'\n'"$3"
  pass "$1"
}

# assert_no_match <what> <extended regex> <text>: no line of the text matches it.
assert_no_match() {
  if grep -qE -- "$2" <<<"$3"; then fail "$1: a line matches: $2"$'\n'"$(grep -E -- "$2" <<<"$3")"; fi
  pass "$1"
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# A stub gcloud: records each call, one per line, and answers as FAKE_MIGRATION says (ok, or fail: the job's
# execution fails the way `gcloud run jobs execute --wait` reports it). FAKE_DESCRIBE=fail makes reading the service
# fail, as when the deploy account can't.
cat >"$scratch/gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf 'gcloud %s\n' "$*" >>"$dir/calls"
case "$*" in
  "run services describe warden-preview "*)
    if [[ ${FAKE_DESCRIBE-} == fail ]]; then
      echo "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED" >&2
      exit 1
    fi
    cat <<JSON
{"metadata":{"name":"warden-preview","annotations":{"run.googleapis.com/urls":"[\"$FAKE_URL_NEW\",\"$FAKE_URL_OLD\"]"}},
 "status":{"url":"$FAKE_URL_NEW"}}
JSON
    ;;
  "run jobs execute "*)
    if [[ $FAKE_MIGRATION == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.execute) The execution failed." >&2
      exit 1
    fi
    ;;
esac
exit 0
FAKE
# A stub curl: records each call, and writes FAKE_HEALTH as the status code curl's -w '%{http_code}' would.
cat >"$scratch/curl" <<'FAKE'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$(dirname "$0")/calls"
printf '%s' "$FAKE_HEALTH"
FAKE
chmod +x "$scratch/gcloud" "$scratch/curl"

# run_deploy <health> <migration> [VAR=value...] -- [arguments]: the script with only the stubs, /usr/bin and /bin on
# PATH, the variables the workflow sets plus any given (VAR= unsets one), no wait between health tries. Its output
# (stdout and stderr) is in $out, its exit code in $code, the stubs' calls in $calls. DEPLOY_SCRIPT runs another
# copy of the script.
run_deploy() {
  local health=$1 migration=$2
  shift 2
  local vars=(GCP_PROJECT_ID="$project" CLOUD_SQL_CONNECTION="$connection" VITE_CLERK_PUBLISHABLE_KEY="$publishable"
    GITHUB_SHA=abc1234def5678abc1234def5678abc1234def56 GITHUB_RUN_NUMBER=12 GITHUB_RUN_ATTEMPT=1)
  while [[ $1 != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  : >"$scratch/calls"
  set +e
  out=$(env -i HOME="$scratch" PATH="$scratch:/usr/bin:/bin" FAKE_HEALTH="$health" FAKE_MIGRATION="$migration" \
    FAKE_URL_NEW="$url_new" FAKE_URL_OLD="$url_old" HEALTH_INTERVAL=0 "${vars[@]}" bash "${DEPLOY_SCRIPT:-$deploy}" \
    "$@" 2>&1)
  code=$?
  set -e
  calls=$(cat "$scratch/calls")
}

# flag <name> <call>: the value of --name=... in that recorded call (no value has a space).
flag() { grep -o -- "--$1=[^ ]*" <<<"$2" | head -1 | cut -d= -f2-; }
# call_of <fixed prefix>: the first recorded call that starts with it; fails when none does.
call_of() {
  local found
  found=$(grep -F -- "$1" <<<"$calls" | head -1)
  [[ -n $found ]] || fail "no recorded call starts: $1"$'\n'"--- calls"$'\n'"$calls"
  printf '%s' "$found"
}
# line_no <fixed prefix>: the line number of the first recorded call containing it.
line_no() { grep -nF -- "$1" <<<"$calls" | head -1 | cut -d: -f1; }
# gcloud_dict <value>: a dict flag's value read the way gcloud reads it (`gcloud topic escaping`): a leading ^D^
# makes D the delimiter, otherwise a comma; each item is KEY=VALUE, split at the first =. One KEY=VALUE per line.
gcloud_dict() {
  local value=$1 delim=,
  if [[ $value =~ ^\^([^^]+)\^(.*)$ ]]; then
    delim=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
  fi
  awk -v RS="$delim" '{ sub(/\n$/, ""); print }' <<<"$value"
}

# --- A preview named demo, everything answering well ---
run_deploy 200 ok -- "$image" preview demo
[[ $code == 0 ]] || fail "preview demo against the stubs failed (exit $code): $out"
pass "preview demo against the stubs exits 0"

job_deploy=$(call_of "gcloud run jobs deploy warden-migrate-preview ")
assert_equal "the migration job runs the image" "$image" "$(flag image "$job_deploy")"
assert_equal "the migration job runs as warden-preview-migrate" \
  "warden-preview-migrate@$project.iam.gserviceaccount.com" "$(flag service-account "$job_deploy")"
assert_equal "the migration job has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$job_deploy")"
assert_equal "the migration job runs node server/src/migrate.ts only" "node server/src/migrate.ts" \
  "$(flag command "$job_deploy") $(flag args "$job_deploy")"
assert_equal "the migration job's plain values: the preview set, as warden_preview_migrate on warden_preview" \
  "PGHOST=/cloudsql/$connection
WARDEN_DATABASE_ROLES=preview
PGUSER=warden_preview_migrate
PGDATABASE=warden_preview" \
  "$(gcloud_dict "$(flag set-env-vars "$job_deploy")")"
job_secrets=$(gcloud_dict "$(flag set-secrets "$job_deploy")")
[[ $job_secrets =~ ^PGPASSWORD=warden-db-preview-migrate-password:[1-9][0-9]*$ ]] ||
  fail "the migration job's only secret is PGPASSWORD, a pinned version of the preview migrate password: $job_secrets"
pass "the migration job's only secret is PGPASSWORD, a pinned version of the preview migrate password"

execute=$(call_of "gcloud run jobs execute warden-migrate-preview ")
assert_line "the script waits for the migration job" "--wait" "$execute"
service_deploy=$(call_of "gcloud run deploy warden-preview ")
(($(line_no "gcloud run jobs deploy") < $(line_no "gcloud run jobs execute"))) ||
  fail "the job is run before it's deployed"
(($(line_no "gcloud run jobs execute") < $(line_no "gcloud run deploy"))) ||
  fail "the revision is deployed before the migration job ends"
pass "the migration job is deployed, then run and waited for, before the revision is deployed"
assert_no_match "no call names roles.ts or the postgres password" 'roles\.ts|warden-db-password' "$calls"

assert_line "the revision gets no traffic" " --no-traffic" "$service_deploy"
assert_equal "the revision is tagged demo" demo "$(flag tag "$service_deploy")"
assert_equal "the revision's suffix is pre-demo-<sha7>-<run>" pre-demo-abc1234-12-1 \
  "$(flag revision-suffix "$service_deploy")"
assert_equal "the revision runs the image" "$image" "$(flag image "$service_deploy")"
assert_equal "the revision runs as warden-preview-run" "warden-preview-run@$project.iam.gserviceaccount.com" \
  "$(flag service-account "$service_deploy")"
assert_equal "the revision has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$service_deploy")"
assert_no_match "no call uses an --update- flag" ' --update-' "$calls"

assert_equal "the revision's plain values, CLERK_AUTHORIZED_PARTIES the tag's two URLs comma-separated and intact" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_preview_app
PGDATABASE=warden_preview
VITE_CLERK_PUBLISHABLE_KEY=$publishable
CLERK_AUTHORIZED_PARTIES=https://demo---warden-preview-123456789012.europe-west1.run.app,https://demo---warden-preview-abcdefghij-ew.a.run.app" \
  "$(gcloud_dict "$(flag set-env-vars "$service_deploy")")"
service_secrets=$(gcloud_dict "$(flag set-secrets "$service_deploy")")
assert_equal "the revision's secrets: the preview app password and the two Clerk keys" \
  "PGPASSWORD=warden-db-preview-app-password
CLERK_SECRET_KEY=warden-clerk-secret
CLERK_JWT_KEY=warden-clerk-jwt-key" \
  "$(sed 's/:[^:]*$//' <<<"$service_secrets")"
assert_equal "each of the revision's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$service_secrets" || true)"

assert_line "the health gate calls /api/health on the tag's URL" \
  "https://demo---warden-preview-123456789012.europe-west1.run.app/api/health" "$(grep '^curl ' <<<"$calls")"
assert_line "after a 200, the script prints the tagged URL" \
  "https://demo---warden-preview-123456789012.europe-west1.run.app" "$out"
assert_no_match "no call moves traffic" 'update-traffic' "$calls"
assert_no_match "no call names the warden service" '^gcloud .* warden( |$)' "$calls"
assert_no_match "no call names a live account" '(^|[^-])warden-(run|migrate|deploy|daily|scheduler)@' "$calls"
assert_no_match "no call names the daily Job" 'warden-daily-expiry' "$calls"
assert_no_match "no call names a live database secret" 'warden-db-(app|migrate|admin)-password' "$calls"

# --- The longest name a tag may have (20 characters) is taken ---
run_deploy 200 ok -- "$image" preview a234567890123456789z
assert_equal "a 20-character name: exit 0" 0 "$code"

# --- No 200 from the health gate ---
run_deploy 503 ok -- "$image" preview demo
assert_equal "with the tag's URL answering 503: exit 1" 1 "$code"
assert_line "with the tag's URL answering 503: says the health check failed" "/api/health" "$out"
(($(grep -c '^curl ' <<<"$calls") > 1)) || fail "the health gate didn't retry"
pass "the health gate retries before giving up"

# --- The migration job fails ---
run_deploy 200 fail -- "$image" preview demo
assert_equal "with the migration job failing: exit 1" 1 "$code"
assert_no_match "with the migration job failing: no revision is deployed" '^gcloud run deploy ' "$calls"
assert_no_match "with the migration job failing: the health gate isn't called" '^curl ' "$calls"

# --- The service's URLs can't be read ---
run_deploy 200 ok FAKE_DESCRIBE=fail -- "$image" preview demo
assert_equal "with the service's URLs unreadable: exit 1" 1 "$code"
assert_line "with the service's URLs unreadable: says so" "couldn't read warden-preview's URLs" "$out"
assert_no_match "with the service's URLs unreadable: no job or revision is deployed" '^gcloud run (jobs )?deploy ' \
  "$calls"

# --- A secret with no pinned version stops the deploy before the gcloud call that would name it ---
# without_pin <secret>: a copy of the script whose version table has no row for that secret.
without_pin() {
  local copy="$scratch/deploy-without-$1.sh"
  grep -vF -- "    $1) echo" "$deploy" >"$copy"
  grep -qF -- "    $1) echo" "$copy" && fail "the copy still pins $1"
  printf '%s' "$copy"
}
# Assigned first, so set -e stops the test when a copy can't be made.
no_migrate_pin=$(without_pin warden-db-preview-migrate-password)
no_jwt_pin=$(without_pin warden-clerk-jwt-key)
DEPLOY_SCRIPT=$no_migrate_pin run_deploy 200 ok -- "$image" preview demo
assert_equal "with no pinned version for the migrate password: exit 1" 1 "$code"
assert_line "with no pinned version for the migrate password: names it" \
  "no pinned version for the secret warden-db-preview-migrate-password" "$out"
assert_no_match "with no pinned version for the migrate password: no job or revision is deployed" \
  '^gcloud run (jobs )?deploy ' "$calls"
DEPLOY_SCRIPT=$no_jwt_pin run_deploy 200 ok -- "$image" preview demo
assert_equal "with no pinned version for the Clerk JWT key: exit 1" 1 "$code"
assert_line "with no pinned version for the Clerk JWT key: names it" \
  "no pinned version for the secret warden-clerk-jwt-key" "$out"
assert_no_match "with no pinned version for the Clerk JWT key: no revision is deployed" '^gcloud run deploy ' "$calls"

# --- Bad input: exit 1 with a message, before any gcloud call ---
# bad_input <what> <expected message> [VAR=value...] -- [arguments]
bad_input() {
  local what=$1 message=$2
  shift 2
  run_deploy 200 ok "$@"
  assert_equal "$what: exit 1" 1 "$code"
  assert_line "$what: says why" "$message" "$out"
  assert_equal "$what: no gcloud call" "" "$calls"
}
name_rule="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"
bad_input "preview Bad_Name" "$name_rule" -- "$image" preview Bad_Name
bad_input "a 21-character name" "$name_rule" -- "$image" preview a2345678901234567890z
bad_input "a name starting with a digit" "$name_rule" -- "$image" preview 1demo
bad_input "a name ending in a hyphen" "$name_rule" -- "$image" preview demo-
bad_input "preview with no name" "usage:" -- "$image" preview
bad_input "no mode" "usage:" -- "$image"
bad_input "no image" "usage:" --
bad_input "release (not yet a mode)" "usage:" -- "$image" release
bad_input "deploy (not a mode)" "usage:" -- "$image" deploy demo
bad_input "an extra argument" "usage:" -- "$image" preview demo extra
bad_input "an unset CLOUD_SQL_CONNECTION" "CLOUD_SQL_CONNECTION" CLOUD_SQL_CONNECTION= -- "$image" preview demo
bad_input "an unset GCP_PROJECT_ID" "GCP_PROJECT_ID" GCP_PROJECT_ID= -- "$image" preview demo
bad_input "an unset VITE_CLERK_PUBLISHABLE_KEY" "VITE_CLERK_PUBLISHABLE_KEY" VITE_CLERK_PUBLISHABLE_KEY= -- \
  "$image" preview demo
bad_input "an unset GITHUB_SHA" "GITHUB_SHA" GITHUB_SHA= -- "$image" preview demo

echo "cloud-run-deploy: all passed"
