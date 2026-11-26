#!/usr/bin/env bash
# The Cloud Run deploy script, preview and release modes: real runs against a stub gcloud and a stub curl, first on
# PATH, which record every call and answer as each case sets, so nothing reaches Google and no credentials are needed.
# Stops at the first failed assertion, exiting 1.
# Run from anywhere: scripts/test/cloud-run-deploy.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
deploy="$root/scripts/cloud-run-deploy.sh"
project=test-project
connection="$project:europe-west1:test-db"
image="europe-west1-docker.pkg.dev/$project/warden-preview/warden:abc1234def5678"
release_image="europe-west1-docker.pkg.dev/$project/warden/warden:abc1234def5678"
publishable=pk_test_Y2ktcGxhY2Vob2xkZXIuY2xlcmsuYWNjb3VudHMuZGV2JA
# The GitHub app's client id (public), as the repository variable WARDEN_GITHUB_APP_CLIENT_ID holds it.
github_client_id=Iv23liExampleClientId0
# The stub reports two URLs for each service <s>: the deterministic one, https://<s>-123456789012.europe-west1.run.app
# (status.url), and the older hash one, https://<s>-abcdefghij-ew.a.run.app (in the run.googleapis.com/urls
# annotation).

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

# A checkout like the release workflow's: main is c1 → c2 → c3 in a bare origin, and side, off c1, is on no branch of
# origin. The script runs in it, and reads main's tip from origin.
fixture_git() {
  env -i HOME="$scratch" PATH=/usr/bin:/bin GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t \
    GIT_COMMITTER_EMAIL=t@example.com git -C "$scratch/repo" "$@"
}
git init -q --bare "$scratch/origin.git"
git init -q -b main "$scratch/repo"
fixture_git remote add origin "$scratch/origin.git"
fixture_git commit -q --allow-empty -m c1
c1=$(fixture_git rev-parse HEAD)
fixture_git commit -q --allow-empty -m c2
c2=$(fixture_git rev-parse HEAD)
fixture_git commit -q --allow-empty -m c3
c3=$(fixture_git rev-parse HEAD)
fixture_git push -q origin main
fixture_git checkout -q -b side "$c1"
fixture_git commit -q --allow-empty -m side
side=$(fixture_git rev-parse HEAD)
fixture_git checkout -q main
# rel_of <commit>: a release revision of that commit, as a release names it.
rel_of() { printf 'warden-rel-%s-9-1' "${1:0:7}"; }

# A stub gcloud: records each call, one per line, and answers as FAKE_MIGRATION says (ok, or fail: the job's
# execution fails the way `gcloud run jobs execute --wait` reports it). FAKE_DESCRIBE=fail makes reading the service
# fail, as when the deploy account can't; FAKE_DESCRIBE=nourl describes a service with no URL at all (no status.url,
# no annotation), as before its first revision is ready. FAKE_DAILY=fail makes updating the daily Job fail, and
# FAKE_SCAN=fail updating the Scan Job; FAKE_SCAN=missing makes describing the Scan Job fail, as before the setup
# script makes it. FAKE_PREVIEW_SCAN does the same for the preview Scan Job, warden-scan-preview. The service's traffic is all on FAKE_SERVING (default: a release revision,
# <service>-rel-0000000-11-1, of a commit that isn't in the checkout), and FAKE_PREVIOUS, when set, is the revision
# tagged previous.
cat >"$scratch/gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf 'gcloud %s\n' "$*" >>"$dir/calls"
case "$*" in
  "run services describe "*)
    service=$4
    case ${FAKE_DESCRIBE-} in
      fail)
        echo "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED" >&2
        exit 1
        ;;
      nourl)
        echo "{\"metadata\":{\"name\":\"$service\",\"annotations\":{}},\"status\":{}}"
        exit 0
        ;;
    esac
    new="https://$service-123456789012.europe-west1.run.app"
    old="https://$service-abcdefghij-ew.a.run.app"
    traffic="{\"revisionName\":\"${FAKE_SERVING:-$service-rel-0000000-11-1}\",\"percent\":100}"
    if [[ -n ${FAKE_PREVIOUS-} ]]; then
      traffic+=",{\"revisionName\":\"$FAKE_PREVIOUS\",\"tag\":\"previous\"}"
    fi
    cat <<JSON
{"metadata":{"name":"$service","annotations":{"run.googleapis.com/urls":"[\"$new\",\"$old\"]"}},
 "status":{"url":"$new","traffic":[$traffic]}}
JSON
    ;;
  "run jobs execute "*)
    if [[ $FAKE_MIGRATION == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.execute) The execution failed." >&2
      exit 1
    fi
    ;;
  "run jobs update warden-daily-expiry "*)
    if [[ ${FAKE_DAILY-} == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.update) PERMISSION_DENIED" >&2
      exit 1
    fi
    ;;
  "run jobs update warden-scan "*)
    if [[ ${FAKE_SCAN-} == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.update) PERMISSION_DENIED" >&2
      exit 1
    fi
    ;;
  "run jobs describe warden-scan "*)
    if [[ ${FAKE_SCAN-} == missing ]]; then
      echo "ERROR: (gcloud.run.jobs.describe) Cannot find job [warden-scan]." >&2
      exit 1
    fi
    echo '{"metadata":{"name":"warden-scan"}}'
    ;;
  "run jobs update warden-scan-preview "*)
    if [[ ${FAKE_PREVIEW_SCAN-} == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.update) PERMISSION_DENIED" >&2
      exit 1
    fi
    ;;
  "run jobs describe warden-scan-preview "*)
    if [[ ${FAKE_PREVIEW_SCAN-} == missing ]]; then
      echo "ERROR: (gcloud.run.jobs.describe) Cannot find job [warden-scan-preview]." >&2
      exit 1
    fi
    echo '{"metadata":{"name":"warden-scan-preview"}}'
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

# run_deploy <health> <migration> [VAR=value...] -- [arguments]: the script in the fixture checkout, with only the
# stubs, /usr/bin and /bin on PATH, the variables the workflow sets (GITHUB_SHA main's tip, c3) plus any given (VAR=
# unsets one), no wait between health tries. Its output (stdout and stderr) is in $out, its exit code in $code, the
# stubs' calls in $calls. DEPLOY_SCRIPT runs another copy of the script.
run_deploy() {
  local health=$1 migration=$2
  shift 2
  local vars=(GCP_PROJECT_ID="$project" CLOUD_SQL_CONNECTION="$connection" VITE_CLERK_PUBLISHABLE_KEY="$publishable"
    WARDEN_GITHUB_APP_CLIENT_ID="$github_client_id" GITHUB_SHA="$c3" GITHUB_RUN_NUMBER=12 GITHUB_RUN_ATTEMPT=1)
  while [[ $1 != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  : >"$scratch/calls"
  set +e
  out=$(cd "$scratch/repo" && env -i HOME="$scratch" PATH="$scratch:/usr/bin:/bin" FAKE_HEALTH="$health" \
    FAKE_MIGRATION="$migration" HEALTH_INTERVAL=0 "${vars[@]}" bash "${DEPLOY_SCRIPT:-$deploy}" "$@" 2>&1)
  code=$?
  set -e
  calls=$(cat "$scratch/calls")
}

# flag <name> <call>: the value of --name=... in that recorded call (no value has a space, but the one spaced_flag
# reads).
flag() { grep -o -- "--$1=[^ ]*" <<<"$2" | head -1 | cut -d= -f2-; }
# spaced_flag <name> <call>: the value of --name=..., which may hold spaces, up to the next " --" in that call.
spaced_flag() {
  local rest=${2#* --$1=}
  [[ $rest != "$2" ]] || return 1
  printf '%s\n' "${rest%% --*}"
}
# What the migration job runs: the migrations, then the CVE snapshot, in one shell, stopping at the first failure.
readonly MIGRATE_JOB="sh -c,node server/src/migrate.ts && node server/src/modules/patch/cve-snapshot.ts"
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
assert_equal "the migration job runs the migrations, then the CVE snapshot loader" "$MIGRATE_JOB" \
  "$(flag command "$job_deploy") $(spaced_flag args "$job_deploy")"
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
assert_equal "the revision's suffix is pre-demo-<sha7>-<run>" "pre-demo-${c3:0:7}-12-1" \
  "$(flag revision-suffix "$service_deploy")"
assert_equal "the revision runs the image" "$image" "$(flag image "$service_deploy")"
assert_equal "the revision runs as warden-preview-run" "warden-preview-run@$project.iam.gserviceaccount.com" \
  "$(flag service-account "$service_deploy")"
assert_equal "the revision has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$service_deploy")"
assert_no_match "no call uses an --update- flag" ' --update-' "$calls"

assert_equal "the revision's plain values, CLERK_AUTHORIZED_PARTIES the tag's two URLs comma-separated and intact, the preview Scan Job's name and the GitHub app's client id" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_preview_app
PGDATABASE=warden_preview
VITE_CLERK_PUBLISHABLE_KEY=$publishable
CLERK_AUTHORIZED_PARTIES=https://demo---warden-preview-123456789012.europe-west1.run.app,https://demo---warden-preview-abcdefghij-ew.a.run.app
WARDEN_SCAN_JOB=projects/$project/locations/europe-west1/jobs/warden-scan-preview
GITHUB_APP_CLIENT_ID=$github_client_id" \
  "$(gcloud_dict "$(flag set-env-vars "$service_deploy")")"
service_secrets=$(gcloud_dict "$(flag set-secrets "$service_deploy")")
# A preview shares the live read-only GitHub app (#275): the same two secrets as a release's revision.
assert_equal "the revision's secrets: the preview app password, the two Clerk keys and the GitHub app's two" \
  "PGPASSWORD=warden-db-preview-app-password
CLERK_SECRET_KEY=warden-clerk-secret
CLERK_JWT_KEY=warden-clerk-jwt-key
GITHUB_APP_CLIENT_SECRET=warden-github-app-client-secret
GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key" \
  "$(sed 's/:[^:]*$//' <<<"$service_secrets")"
assert_equal "each of the revision's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$service_secrets" || true)"

assert_line "the health gate calls /api/health on the tag's URL" \
  "https://demo---warden-preview-123456789012.europe-west1.run.app/api/health" "$(grep '^curl ' <<<"$calls")"
assert_line "after a 200, the script prints the tagged URL" \
  "https://demo---warden-preview-123456789012.europe-west1.run.app" "$out"

(($(line_no "gcloud run jobs describe warden-scan-preview ") < $(line_no "gcloud run jobs deploy warden-migrate-preview "))) ||
  fail "the migration runs before the preview Scan Job is found"
pass "the preview Scan Job is found before anything is migrated or deployed"
preview_scan=$(call_of "gcloud run jobs update warden-scan-preview ")
(($(line_no "curl ") < $(line_no "gcloud run jobs update warden-scan-preview "))) ||
  fail "the preview Scan Job is updated before the health gate answers"
pass "the preview Scan Job is updated after the health gate"
assert_equal "the preview Scan Job runs the preview's image" "$image" "$(flag image "$preview_scan")"
assert_equal "the preview Scan Job runs as warden-preview-scan" \
  "warden-preview-scan@$project.iam.gserviceaccount.com" "$(flag service-account "$preview_scan")"
assert_equal "the preview Scan Job runs node server/src/scan-job.ts" "node server/src/scan-job.ts" \
  "$(flag command "$preview_scan") $(flag args "$preview_scan")"
assert_equal "the preview Scan Job has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$preview_scan")"
assert_equal "the preview Scan Job retries once" 1 "$(flag max-retries "$preview_scan")"
assert_equal "the preview Scan Job's task may take an hour" 3600s "$(flag task-timeout "$preview_scan")"
assert_equal "the preview Scan Job's plain values: as warden_preview_app on warden_preview, and the GitHub app's client id" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_preview_app
PGDATABASE=warden_preview
GITHUB_APP_CLIENT_ID=$github_client_id" \
  "$(gcloud_dict "$(flag set-env-vars "$preview_scan")")"
preview_scan_secrets=$(gcloud_dict "$(flag set-secrets "$preview_scan")")
assert_equal "the preview Scan Job's two secrets: the preview app password and the GitHub app's private key, never the client secret" \
  "PGPASSWORD=warden-db-preview-app-password
GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key" \
  "$(sed 's/:[^:]*$//' <<<"$preview_scan_secrets")"
assert_equal "each of the preview Scan Job's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$preview_scan_secrets" || true)"

assert_no_match "no call moves traffic" 'update-traffic' "$calls"
assert_no_match "no call names the warden service" '^gcloud .* warden( |$)' "$calls"
assert_no_match "no call names a live account" '(^|[^-])warden-(run|migrate|deploy|daily|scan|scheduler)@' "$calls"
assert_no_match "no call names the daily Job" 'warden-daily-expiry' "$calls"
assert_no_match "no call names the live Scan Job" 'warden-scan($|[^-])' "$calls"
assert_no_match "no call names the live migration job" 'warden-migrate( |$)' "$calls"
assert_no_match "no call names a live database secret" 'warden-db-(app|migrate|admin)-password' "$calls"

# --- A preview with no preview Scan Job yet (the setup script not rerun): nothing is migrated or deployed ---
run_deploy 200 ok FAKE_PREVIEW_SCAN=missing -- "$image" preview demo
assert_equal "preview, with no preview Scan Job: exit 1" 1 "$code"
assert_line "preview, with no preview Scan Job: names the Job" "warden-scan-preview" "$out"
assert_line "preview, with no preview Scan Job: says to rerun the setup script" "rerun scripts/gcp-setup.sh" "$out"
assert_no_match "preview, with no preview Scan Job: nothing is migrated, deployed or updated" \
  '^gcloud run (jobs (deploy|execute|update)|deploy) ' "$calls"

# --- A preview whose Scan Job update fails: the revision is up, and the run names warden-scan-preview ---
run_deploy 200 ok FAKE_PREVIEW_SCAN=fail -- "$image" preview demo
assert_equal "preview, with the preview Scan Job's update failing: exit 1" 1 "$code"
assert_line "preview, with the preview Scan Job's update failing: names the Job" "warden-scan-preview" "$out"
assert_line "preview, with the preview Scan Job's update failing: the revision was deployed" \
  "gcloud run deploy warden-preview " "$calls"

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

# --- The service reports no URL: jq reads a missing status.url as null, which is no URL ---
for mode in "preview demo" release; do
  # shellcheck disable=SC2086 # the mode and its name are two words
  run_deploy 200 ok FAKE_DESCRIBE=nourl -- "$image" $mode
  assert_equal "$mode, with the service reporting no URL: exit 1" 1 "$code"
  assert_line "$mode, with the service reporting no URL: says so" "reports no URL" "$out"
  assert_no_match "$mode, with the service reporting no URL: no job or revision is deployed" \
    '^gcloud run (jobs )?deploy ' "$calls"
done

# --- A release, everything answering well ---
run_deploy 200 ok -- "$release_image" release
[[ $code == 0 ]] || fail "release against the stubs failed (exit $code): $out"
pass "release against the stubs exits 0"

job_deploy=$(call_of "gcloud run jobs deploy warden-migrate ")
assert_equal "release: the migration job runs the image" "$release_image" "$(flag image "$job_deploy")"
assert_equal "release: the migration job runs as warden-migrate" \
  "warden-migrate@$project.iam.gserviceaccount.com" "$(flag service-account "$job_deploy")"
assert_equal "release: the migration job has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$job_deploy")"
assert_equal "release: the migration job runs the migrations, then the CVE snapshot loader" "$MIGRATE_JOB" \
  "$(flag command "$job_deploy") $(spaced_flag args "$job_deploy")"
assert_equal "release: the migration job's plain values: the live set, as warden_migrate on warden" \
  "PGHOST=/cloudsql/$connection
WARDEN_DATABASE_ROLES=live
PGUSER=warden_migrate
PGDATABASE=warden" \
  "$(gcloud_dict "$(flag set-env-vars "$job_deploy")")"
job_secrets=$(gcloud_dict "$(flag set-secrets "$job_deploy")")
[[ $job_secrets =~ ^PGPASSWORD=warden-db-migrate-password:[1-9][0-9]*$ ]] ||
  fail "release: the migration job's only secret is PGPASSWORD, a pinned version of the migrate password: $job_secrets"
pass "release: the migration job's only secret is PGPASSWORD, a pinned version of the migrate password"
assert_line "release: the script waits for the migration job" "--wait" \
  "$(call_of "gcloud run jobs execute warden-migrate ")"
(($(line_no "gcloud run jobs deploy warden-migrate ") < $(line_no "gcloud run jobs execute warden-migrate "))) ||
  fail "release: the job is run before it's deployed"
(($(line_no "gcloud run jobs execute warden-migrate ") < $(line_no "gcloud run deploy warden "))) ||
  fail "release: the revision is deployed before the migration job ends"
pass "release: the migration job is deployed, then run and waited for, before the revision is deployed"
assert_no_match "release: no call names roles.ts or the postgres password" 'roles\.ts|warden-db-password' "$calls"

service_deploy=$(call_of "gcloud run deploy warden ")
assert_line "release: the revision gets no traffic" " --no-traffic" "$service_deploy"
assert_equal "release: the revision is tagged candidate" candidate "$(flag tag "$service_deploy")"
assert_equal "release: the revision's suffix is rel-<sha7>-<run>-<attempt>" "rel-${c3:0:7}-12-1" \
  "$(flag revision-suffix "$service_deploy")"
assert_equal "release: the revision runs the image" "$release_image" "$(flag image "$service_deploy")"
assert_equal "release: the revision runs as warden-run" "warden-run@$project.iam.gserviceaccount.com" \
  "$(flag service-account "$service_deploy")"
assert_equal "release: the revision has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$service_deploy")"
assert_no_match "release: neither the job nor the revision deploy uses an --update- flag" ' --update-' \
  "$job_deploy"$'\n'"$service_deploy"
assert_equal "release: the revision's plain values, CLERK_AUTHORIZED_PARTIES the service's two URLs comma-separated and intact, the Scan Job's name and the GitHub app's client id" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_app
PGDATABASE=warden
VITE_CLERK_PUBLISHABLE_KEY=$publishable
CLERK_AUTHORIZED_PARTIES=https://warden-123456789012.europe-west1.run.app,https://warden-abcdefghij-ew.a.run.app
WARDEN_SCAN_JOB=projects/$project/locations/europe-west1/jobs/warden-scan
GITHUB_APP_CLIENT_ID=$github_client_id" \
  "$(gcloud_dict "$(flag set-env-vars "$service_deploy")")"
service_secrets=$(gcloud_dict "$(flag set-secrets "$service_deploy")")
assert_equal "release: the revision's secrets: the app password, the two Clerk keys and the GitHub app's two" \
  "PGPASSWORD=warden-db-app-password
CLERK_SECRET_KEY=warden-clerk-secret
CLERK_JWT_KEY=warden-clerk-jwt-key
GITHUB_APP_CLIENT_SECRET=warden-github-app-client-secret
GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key" \
  "$(sed 's/:[^:]*$//' <<<"$service_secrets")"
assert_equal "release: the GitHub app's secrets are pinned at version 1, as #132 makes them" \
  "GITHUB_APP_CLIENT_SECRET=warden-github-app-client-secret:1
GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key:1" \
  "$(grep '^GITHUB_APP_' <<<"$service_secrets")"
assert_equal "release: each of the revision's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$service_secrets" || true)"

assert_line "release: the health gate calls /api/health on the candidate tag's URL" \
  "https://candidate---warden-123456789012.europe-west1.run.app/api/health" "$(grep '^curl ' <<<"$calls")"
traffic=$(call_of "gcloud run services update-traffic warden ")
assert_equal "release: traffic moves, all of it, to the new revision by name" "warden-rel-${c3:0:7}-12-1=100" \
  "$(flag to-revisions "$traffic")"
assert_equal "release: the same call tags the release that was serving previous, for a rollback" \
  "previous=warden-rel-0000000-11-1" "$(flag update-tags "$traffic")"
assert_no_match "release: no call moves traffic to the latest revision" '--to-latest' "$calls"
(($(line_no "curl ") < $(line_no "gcloud run services update-traffic"))) ||
  fail "release: traffic moves before the health gate answers"
pass "release: traffic moves after the health gate's 200"

daily=$(call_of "gcloud run jobs update warden-daily-expiry ")
(($(line_no "gcloud run services update-traffic") < $(line_no "gcloud run jobs update warden-daily-expiry "))) ||
  fail "release: the daily Job is updated before traffic moves"
pass "release: the daily Job is updated after traffic moves"
assert_equal "release: the daily Job runs the release's image" "$release_image" "$(flag image "$daily")"
assert_equal "release: the daily Job runs as warden-daily" "warden-daily@$project.iam.gserviceaccount.com" \
  "$(flag service-account "$daily")"
assert_equal "release: the daily Job runs node server/src/daily-expiry.ts" "node server/src/daily-expiry.ts" \
  "$(flag command "$daily") $(flag args "$daily")"
assert_equal "release: the daily Job has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$daily")"
assert_equal "release: the daily Job retries once" 1 "$(flag max-retries "$daily")"
assert_equal "release: the daily Job's plain values: as warden_app on warden" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_app
PGDATABASE=warden" \
  "$(gcloud_dict "$(flag set-env-vars "$daily")")"
daily_secrets=$(gcloud_dict "$(flag set-secrets "$daily")")
assert_equal "release: the daily Job's secrets: the app password and the admin password" \
  "PGPASSWORD=warden-db-app-password
WARDEN_ADMIN_PASSWORD=warden-db-admin-password" \
  "$(sed 's/:[^:]*$//' <<<"$daily_secrets")"
assert_equal "release: each of the daily Job's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$daily_secrets" || true)"

(($(line_no "gcloud run jobs describe warden-scan ") < $(line_no "gcloud run jobs deploy warden-migrate "))) ||
  fail "release: the migration runs before the Scan Job is found"
pass "release: the Scan Job is found before anything is migrated or deployed"
scan=$(call_of "gcloud run jobs update warden-scan ")
(($(line_no "curl ") < $(line_no "gcloud run jobs update warden-scan "))) ||
  fail "release: the Scan Job is updated before the health gate answers"
(($(line_no "gcloud run jobs update warden-scan ") < $(line_no "gcloud run services update-traffic"))) ||
  fail "release: traffic moves before the Scan Job is updated"
pass "release: the Scan Job is updated after the health gate, before traffic moves"
assert_equal "release: the Scan Job runs the release's image" "$release_image" "$(flag image "$scan")"
assert_equal "release: the Scan Job runs as warden-scan" "warden-scan@$project.iam.gserviceaccount.com" \
  "$(flag service-account "$scan")"
assert_equal "release: the Scan Job runs node server/src/scan-job.ts" "node server/src/scan-job.ts" \
  "$(flag command "$scan") $(flag args "$scan")"
assert_equal "release: the Scan Job has the Cloud SQL instance attached" "$connection" \
  "$(flag set-cloudsql-instances "$scan")"
assert_equal "release: the Scan Job retries once" 1 "$(flag max-retries "$scan")"
assert_equal "release: the Scan Job's task may take an hour" 3600s "$(flag task-timeout "$scan")"
assert_equal "release: the Scan Job's plain values: as warden_app on warden, and the GitHub app's client id" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_app
PGDATABASE=warden
GITHUB_APP_CLIENT_ID=$github_client_id" \
  "$(gcloud_dict "$(flag set-env-vars "$scan")")"
# The Scan Job reads repos with the GitHub app's private key alone: never its client secret, which signs people in.
scan_secrets=$(gcloud_dict "$(flag set-secrets "$scan")")
assert_equal "release: the Scan Job's two secrets: the app password and the GitHub app's private key" \
  "PGPASSWORD=warden-db-app-password
GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key" \
  "$(sed 's/:[^:]*$//' <<<"$scan_secrets")"
assert_equal "release: each of the Scan Job's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$scan_secrets" || true)"

assert_no_match "release: no call names Cloud Scheduler" '^gcloud scheduler' "$calls"
assert_no_match "release: no call names a preview service, job or account" 'warden-preview|warden-migrate-preview' \
  "$calls"
assert_line "release: after the traffic move, the script prints the service's URL" \
  "https://warden-123456789012.europe-west1.run.app" "$out"
assert_line "release: the last line names the Scan Job" "warden-scan" "$(tail -1 <<<"$out")"

# --- The first release, from Google's placeholder: no release to tag previous ---
run_deploy 200 ok FAKE_SERVING=warden-00001-xyz -- "$release_image" release
assert_equal "release from the placeholder: exit 0" 0 "$code"
assert_no_match "release from the placeholder: the placeholder isn't tagged previous" '--update-tags' "$calls"
assert_no_match "release from the placeholder, with no previous tag: no tag is removed" '--remove-tags' "$calls"

# --- A release from a revision that isn't a release (after a rollback to it by name): a stale previous goes ---
run_deploy 200 ok FAKE_SERVING=warden-00001-xyz FAKE_PREVIOUS="$(rel_of "$c1")" -- "$release_image" release
assert_equal "release from a non-release with a stale previous: exit 0" 0 "$code"
traffic=$(call_of "gcloud run services update-traffic warden ")
assert_equal "release from a non-release with a stale previous: the same call removes the previous tag" previous \
  "$(flag remove-tags "$traffic")"
assert_no_match "release from a non-release with a stale previous: nothing is tagged previous" '--update-tags' \
  "$traffic"

# --- Which commit releases: only one on main, and only one newer than the serving release ---
# A commit newer than the serving release releases, even when main's tip (c3) is newer still and never released (its
# full lane failed, or it skipped CI).
run_deploy 200 ok GITHUB_SHA="$c2" FAKE_SERVING="$(rel_of "$c1")" -- "$release_image" release
assert_equal "c2, with c1 serving and c3 main's tip: exit 0" 0 "$code"
assert_equal "c2, with c1 serving and c3 main's tip: releases c2" "warden-rel-${c2:0:7}-12-1=100" \
  "$(flag to-revisions "$(call_of "gcloud run services update-traffic warden ")")"
# An older commit than the serving release skips everything, and exits 0.
run_deploy 200 ok GITHUB_SHA="$c2" FAKE_SERVING="$(rel_of "$c3")" -- "$release_image" release
assert_equal "c2, with c3 serving: exit 0" 0 "$code"
assert_line "c2, with c3 serving: says a newer commit is serving" "newer" "$out"
assert_no_match "c2, with c3 serving: nothing is migrated, deployed, moved or updated" \
  '^gcloud run (jobs (deploy|execute|update)|deploy|services update-traffic) ' "$calls"
# The same commit as the serving release (a re-run after the daily Job's update failed): only the daily Job is set.
run_deploy 200 ok GITHUB_SHA="$c2" FAKE_SERVING="$(rel_of "$c2")" -- "$release_image" release
assert_equal "c2, with c2 serving: exit 0" 0 "$code"
assert_line "c2, with c2 serving: says it's already serving" "already serving" "$out"
assert_no_match "c2, with c2 serving: nothing is migrated, deployed or moved" \
  '^gcloud run (jobs (deploy|execute)|deploy|services update-traffic) ' "$calls"
assert_equal "c2, with c2 serving: the daily Job is set to the release's image" "$release_image" \
  "$(flag image "$(call_of "gcloud run jobs update warden-daily-expiry ")")"
assert_equal "c2, with c2 serving: the Scan Job is set to the release's image" "$release_image" \
  "$(flag image "$(call_of "gcloud run jobs update warden-scan ")")"
assert_line "c2, with c2 serving: says both Jobs were set" "warden-scan" "$out"
# The same re-run, with the Scan Job's update failing: exit 1, naming it.
run_deploy 200 ok GITHUB_SHA="$c2" FAKE_SERVING="$(rel_of "$c2")" FAKE_SCAN=fail -- "$release_image" release
assert_equal "c2, with c2 serving and the Scan Job's update failing: exit 1" 1 "$code"
assert_line "c2, with c2 serving and the Scan Job's update failing: names the Job" "warden-scan" "$out"
# A commit that isn't on main stops before anything changes.
run_deploy 200 ok GITHUB_SHA="$side" FAKE_SERVING="$(rel_of "$c1")" -- "$release_image" release
assert_equal "a commit not on main: exit 1" 1 "$code"
assert_line "a commit not on main: says so" "isn't on main" "$out"
assert_no_match "a commit not on main: nothing is migrated or deployed" '^gcloud run (jobs )?deploy ' "$calls"

# --- A release whose candidate never answers 200 ---
run_deploy 503 ok -- "$release_image" release
assert_equal "release, with the candidate answering 503: exit 1" 1 "$code"
assert_no_match "release, with the candidate answering 503: no traffic moves" 'update-traffic' "$calls"
assert_no_match "release, with the candidate answering 503: the daily Job isn't touched" 'warden-daily-expiry' "$calls"
assert_no_match "release, with the candidate answering 503: the Scan Job isn't touched" 'jobs update warden-scan' "$calls"

# --- A release whose migration fails ---
run_deploy 200 fail -- "$release_image" release
assert_equal "release, with the migration job failing: exit 1" 1 "$code"
assert_no_match "release, with the migration job failing: no revision is deployed" '^gcloud run deploy ' "$calls"
assert_no_match "release, with the migration job failing: no traffic moves" 'update-traffic' "$calls"

# --- A release whose daily Job update fails: traffic has moved, and the run says the Job is behind ---
run_deploy 200 ok FAKE_DAILY=fail -- "$release_image" release
assert_equal "release, with the daily Job's update failing: exit 1" 1 "$code"
assert_line "release, with the daily Job's update failing: traffic had moved" \
  "gcloud run services update-traffic warden " "$calls"
assert_line "release, with the daily Job's update failing: names the Job" "warden-daily-expiry" "$out"

# --- A release whose Scan Job update fails: traffic stays, and the run names warden-scan ---
run_deploy 200 ok FAKE_SCAN=fail -- "$release_image" release
assert_equal "release, with the Scan Job's update failing: exit 1" 1 "$code"
assert_line "release, with the Scan Job's update failing: names the Job" "warden-scan" "$out"
assert_line "release, with the Scan Job's update failing: says traffic didn't move" "no traffic moved" "$out"
assert_no_match "release, with the Scan Job's update failing: no traffic moves" 'update-traffic' "$calls"
assert_no_match "release, with the Scan Job's update failing: the daily Job isn't touched" 'warden-daily-expiry' \
  "$calls"

# --- A release with no Scan Job yet (the setup script not rerun): nothing is migrated, deployed or moved ---
run_deploy 200 ok FAKE_SCAN=missing -- "$release_image" release
assert_equal "release, with no Scan Job: exit 1" 1 "$code"
assert_line "release, with no Scan Job: names the Job" "warden-scan" "$out"
assert_line "release, with no Scan Job: says what makes it" "scripts/gcp-setup.sh" "$out"
assert_no_match "release, with no Scan Job: nothing is migrated, deployed, moved or updated" \
  '^gcloud run (jobs (deploy|execute|update)|deploy|services update-traffic) ' "$calls"

# --- A secret with no pinned version stops the deploy before the gcloud call that would name it ---
# without_pin <secret>: a copy of the script and its library, whose version table has no row for that secret.
without_pin() {
  local dir="$scratch/without-$1"
  mkdir -p "$dir/lib"
  cp "$deploy" "$dir/cloud-run-deploy.sh"
  grep -vF -- "    $1) echo" "$root/scripts/lib/cloud-run.sh" >"$dir/lib/cloud-run.sh"
  grep -qF -- "    $1) echo" "$dir/lib/cloud-run.sh" && fail "the copy still pins $1"
  printf '%s' "$dir/cloud-run-deploy.sh"
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
bad_input "release with an extra argument" "usage:" -- "$image" release extra
bad_input "deploy (not a mode)" "usage:" -- "$image" deploy demo
bad_input "an extra argument" "usage:" -- "$image" preview demo extra
bad_input "an unset CLOUD_SQL_CONNECTION" "CLOUD_SQL_CONNECTION" CLOUD_SQL_CONNECTION= -- "$image" preview demo
bad_input "an unset GCP_PROJECT_ID" "GCP_PROJECT_ID" GCP_PROJECT_ID= -- "$image" preview demo
bad_input "an unset VITE_CLERK_PUBLISHABLE_KEY" "VITE_CLERK_PUBLISHABLE_KEY" VITE_CLERK_PUBLISHABLE_KEY= -- \
  "$image" preview demo
bad_input "an unset GITHUB_SHA" "GITHUB_SHA" GITHUB_SHA= -- "$image" preview demo
bad_input "a release with an unset WARDEN_GITHUB_APP_CLIENT_ID" "set WARDEN_GITHUB_APP_CLIENT_ID" \
  WARDEN_GITHUB_APP_CLIENT_ID= -- "$release_image" release
# A preview's revision and Scan Job read the GitHub app too (#275).
bad_input "a preview with an unset WARDEN_GITHUB_APP_CLIENT_ID" "set WARDEN_GITHUB_APP_CLIENT_ID" \
  WARDEN_GITHUB_APP_CLIENT_ID= -- "$image" preview demo

echo "cloud-run-deploy: all passed"
