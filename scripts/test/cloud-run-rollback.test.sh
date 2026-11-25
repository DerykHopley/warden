#!/usr/bin/env bash
# The Cloud Run rollback script: real runs against a stub gcloud and a stub curl, first on PATH, which record every
# call and answer as each case sets, so nothing reaches Google and no credentials are needed. Stops at the first
# failed assertion, exiting 1.
# Run from anywhere: scripts/test/cloud-run-rollback.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
rollback="$root/scripts/cloud-run-rollback.sh"
project=test-project
connection="$project:europe-west1:test-db"
registry="europe-west1-docker.pkg.dev/$project/warden/warden"
service_url=https://warden-123456789012.europe-west1.run.app
rollback_url=https://rollback---warden-123456789012.europe-west1.run.app

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

# warden's revisions as `gcloud run revisions list --format=json` gives them, out of order: Google's placeholder from
# the setup script and three releases. bbbbbbb-11 sits between two good ones but never served (its health gate
# failed), so no release tagged it previous. Each holds the digest Cloud Run resolved its image to.
cat >"$scratch/revisions.json" <<JSON
[
  {"metadata":{"name":"warden-rel-bbbbbbb-11-1","creationTimestamp":"2026-11-26T10:00:00.123456Z"},
   "spec":{"containers":[{"image":"$registry:bbbbbbb"}]},"status":{"imageDigest":"$registry@sha256:bbbb"}},
  {"metadata":{"name":"warden-00001-xyz","creationTimestamp":"2026-11-20T10:00:00Z"},
   "spec":{"containers":[{"image":"us-docker.pkg.dev/cloudrun/container/hello"}]},
   "status":{"imageDigest":"us-docker.pkg.dev/cloudrun/container/hello@sha256:0000"}},
  {"metadata":{"name":"warden-rel-ccccccc-12-1","creationTimestamp":"2026-11-27T10:00:00Z"},
   "spec":{"containers":[{"image":"$registry:ccccccc"}]},"status":{"imageDigest":"$registry@sha256:cccc"}},
  {"metadata":{"name":"warden-rel-aaaaaaa-10-1","creationTimestamp":"2026-11-25T10:00:00Z"},
   "spec":{"containers":[{"image":"$registry:aaaaaaa"}]},"status":{"imageDigest":"$registry@sha256:aaaa"}}
]
JSON

# A stub gcloud: records each call, one per line. The service's traffic is all on FAKE_SERVING (or split 50/50 with
# the placeholder, with FAKE_SPLIT=1), and FAKE_PREVIOUS, when set, is the revision tagged previous. With
# FAKE_SERVING_LATER set, every describe after the first reports that revision serving: a release moved the traffic.
# FAKE_SCAN=fail makes updating the Scan Job fail.
cat >"$scratch/gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf 'gcloud %s\n' "$*" >>"$dir/calls"
case "$*" in
  "run services describe warden "*)
    serving=$FAKE_SERVING
    if [[ -n ${FAKE_SERVING_LATER-} && $(grep -c '^gcloud run services describe ' "$dir/calls") -gt 1 ]]; then
      serving=$FAKE_SERVING_LATER
    fi
    if [[ ${FAKE_SPLIT-} == 1 ]]; then
      traffic="{\"revisionName\":\"$serving\",\"percent\":50},{\"revisionName\":\"warden-00001-xyz\",\"percent\":50}"
    else
      traffic="{\"revisionName\":\"$serving\",\"percent\":100}"
    fi
    if [[ -n ${FAKE_PREVIOUS-} ]]; then
      traffic+=",{\"revisionName\":\"$FAKE_PREVIOUS\",\"tag\":\"previous\"}"
    fi
    echo "{\"metadata\":{\"name\":\"warden\"},\"status\":{\"url\":\"https://warden-123456789012.europe-west1.run.app\",\"traffic\":[$traffic]}}"
    ;;
  "run revisions list "*) cat "$dir/revisions.json" ;;
  "run jobs update warden-scan "*)
    if [[ ${FAKE_SCAN-} == fail ]]; then
      echo "ERROR: (gcloud.run.jobs.update) PERMISSION_DENIED" >&2
      exit 1
    fi
    ;;
esac
exit 0
FAKE
# A stub curl: records each call, and writes the status code curl's -w '%{http_code}' would: FAKE_TAG_HEALTH for a
# tag's URL (default FAKE_HEALTH), FAKE_HEALTH for the service's own.
cat >"$scratch/curl" <<'FAKE'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$(dirname "$0")/calls"
case "$*" in
  *---*) printf '%s' "${FAKE_TAG_HEALTH:-$FAKE_HEALTH}" ;;
  *) printf '%s' "$FAKE_HEALTH" ;;
esac
FAKE
chmod +x "$scratch/gcloud" "$scratch/curl"

# run_rollback <health> <serving revision> [VAR=value...] -- [arguments]: the script with only the stubs, /usr/bin
# and /bin on PATH, GCP_PROJECT_ID and CLOUD_SQL_CONNECTION plus any variable given (VAR= unsets one), and
# aaaaaaa-10-1 tagged previous unless FAKE_PREVIOUS says otherwise; no wait between health tries. Its output (stdout
# and stderr) is in $out, its exit code in $code, the stubs' calls in $calls.
run_rollback() {
  local health=$1 serving=$2
  shift 2
  local vars=(GCP_PROJECT_ID="$project" CLOUD_SQL_CONNECTION="$connection" FAKE_PREVIOUS=warden-rel-aaaaaaa-10-1)
  while [[ $1 != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  : >"$scratch/calls"
  set +e
  out=$(env -i HOME="$scratch" PATH="$scratch:/usr/bin:/bin" FAKE_HEALTH="$health" FAKE_SERVING="$serving" \
    HEALTH_INTERVAL=0 HEALTH_ATTEMPTS=3 "${vars[@]}" bash "$rollback" "$@" 2>&1)
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
# line_no <fixed string>: the line number of the first recorded call containing it.
line_no() { grep -nF -- "$1" <<<"$calls" | head -1 | cut -d: -f1; }
# gcloud_dict <value>: a dict flag's value read the way gcloud reads it (`gcloud topic escaping`), one KEY=VALUE per
# line.
gcloud_dict() {
  local value=$1 delim=,
  if [[ $value =~ ^\^([^^]+)\^(.*)$ ]]; then
    delim=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
  fi
  awk -v RS="$delim" '{ sub(/\n$/, ""); print }' <<<"$value"
}

# --- No revision named: back to the release tagged previous, past a newer one that never served ---
run_rollback 200 warden-rel-ccccccc-12-1 ROLLBACK_FROM=warden-rel-ccccccc-12-1 --
[[ $code == 0 ]] || fail "a rollback from ccccccc-12-1 failed (exit $code): $out"
pass "a rollback from ccccccc-12-1 exits 0"
tag=$(call_of "gcloud run services update-traffic warden --update-tags=")
assert_equal "aaaaaaa-10-1, tagged previous, is tagged rollback first, past bbbbbbb-11-1 which never served" \
  "rollback=warden-rel-aaaaaaa-10-1" "$(flag update-tags "$tag")"
assert_no_match "tagging it moves no traffic" '--to-' "$tag"
assert_line "its health is checked on the rollback tag's URL" "$rollback_url/api/health" "$calls"
traffic=$(call_of "gcloud run services update-traffic warden --to-revisions=")
assert_equal "then all traffic goes to it, by name" "warden-rel-aaaaaaa-10-1=100" "$(flag to-revisions "$traffic")"
assert_no_match "no call moves traffic to the latest revision" '--to-latest' "$calls"
(($(line_no "--update-tags=rollback=") < $(line_no "$rollback_url"))) || fail "health is checked before the tag"
(($(line_no "$rollback_url") < $(line_no "--to-revisions="))) || fail "traffic moves before the tag's health check"
(($(line_no "--to-revisions=") < $(line_no "gcloud run jobs update warden-daily-expiry "))) ||
  fail "the daily Job moves before the traffic does"
(($(line_no "gcloud run jobs update") < $(line_no "curl -sS -o /dev/null -w %{http_code} --max-time 10 $service_url"))) ||
  fail "the service's health check runs before the Job moves"
pass "tag, its health check, traffic, the daily Job, then the service's health check, in that order"

job=$(call_of "gcloud run jobs update warden-daily-expiry ")
assert_equal "the daily Job runs aaaaaaa-10-1's image by digest" "$registry@sha256:aaaa" "$(flag image "$job")"
assert_equal "the daily Job's whole configuration is set: as warden-daily" \
  "warden-daily@$project.iam.gserviceaccount.com" "$(flag service-account "$job")"
assert_equal "the daily Job's whole configuration is set: daily-expiry.ts, one retry, the instance" \
  "node server/src/daily-expiry.ts 1 $connection" \
  "$(flag command "$job") $(flag args "$job") $(flag max-retries "$job") $(flag set-cloudsql-instances "$job")"
assert_equal "the daily Job's whole configuration is set: its plain values" \
  "PGHOST=/cloudsql/$connection
PGUSER=warden_app
PGDATABASE=warden" \
  "$(gcloud_dict "$(flag set-env-vars "$job")")"
job_secrets=$(gcloud_dict "$(flag set-secrets "$job")")
assert_equal "the daily Job's whole configuration is set: its two passwords" \
  "PGPASSWORD=warden-db-app-password
WARDEN_ADMIN_PASSWORD=warden-db-admin-password" \
  "$(sed 's/:[^:]*$//' <<<"$job_secrets")"
assert_equal "each of the daily Job's secrets is pinned to a version number" "" \
  "$(grep -vE '^[A-Z_]+=[a-z-]+:[1-9][0-9]*$' <<<"$job_secrets" || true)"
# The Scan Job's configuration comes from update_scan_job, which the deploy test checks; here, only what a rollback
# adds: the target's image, and when.
(($(line_no "gcloud run jobs update warden-daily-expiry ") < $(line_no "gcloud run jobs update warden-scan "))) ||
  fail "the Scan Job moves before the daily Job does"
(($(line_no "gcloud run jobs update warden-scan ") < $(line_no "curl -sS -o /dev/null -w %{http_code} --max-time 10 $service_url"))) ||
  fail "the service's health check runs before the Scan Job moves"
pass "the Scan Job moves after the daily Job, before the service's health check"
assert_equal "the Scan Job runs aaaaaaa-10-1's image by digest" "$registry@sha256:aaaa" \
  "$(flag image "$(call_of "gcloud run jobs update warden-scan ")")"
assert_no_match "no call names Cloud Scheduler" '^gcloud scheduler' "$calls"
assert_line "it says where traffic went" "warden-rel-aaaaaaa-10-1" "$out"
assert_line "its last line names the daily Job" "warden-daily-expiry" "$(tail -1 <<<"$out")"
assert_line "its last line names the Scan Job" "warden-scan" "$(tail -1 <<<"$out")"

# --- A named revision (an incident): the same checks, on that one ---
run_rollback 200 warden-rel-ccccccc-12-1 -- warden-rel-bbbbbbb-11-1
assert_equal "a rollback to bbbbbbb-11-1 by name: exit 0" 0 "$code"
assert_equal "a rollback to bbbbbbb-11-1 by name: tagged rollback first" "rollback=warden-rel-bbbbbbb-11-1" \
  "$(flag update-tags "$(call_of "gcloud run services update-traffic warden --update-tags=")")"
assert_equal "a rollback to bbbbbbb-11-1 by name: all traffic goes to it" "warden-rel-bbbbbbb-11-1=100" \
  "$(flag to-revisions "$(call_of "gcloud run services update-traffic warden --to-revisions=")")"
assert_equal "a rollback to bbbbbbb-11-1 by name: the daily Job runs its digest" "$registry@sha256:bbbb" \
  "$(flag image "$(call_of "gcloud run jobs update warden-daily-expiry ")")"
assert_equal "a rollback to bbbbbbb-11-1 by name: the Scan Job runs its digest" "$registry@sha256:bbbb" \
  "$(flag image "$(call_of "gcloud run jobs update warden-scan ")")"

# --- The Scan Job's update fails: traffic and the daily Job have moved, and the run names warden-scan ---
run_rollback 200 warden-rel-ccccccc-12-1 FAKE_SCAN=fail --
assert_equal "with the Scan Job's update failing: exit 1" 1 "$code"
assert_line "with the Scan Job's update failing: names the Job" "warden-scan" "$out"
assert_line "with the Scan Job's update failing: traffic had moved" "--to-revisions=warden-rel-aaaaaaa-10-1=100" \
  "$calls"
assert_line "with the Scan Job's update failing: the daily Job had moved" "gcloud run jobs update warden-daily-expiry " \
  "$calls"

# --- The target fails its health check on the rollback tag: traffic stays ---
run_rollback 200 warden-rel-ccccccc-12-1 FAKE_TAG_HEALTH=503 -- warden-rel-bbbbbbb-11-1
assert_equal "with the rollback tag answering 503: exit 1" 1 "$code"
assert_line "with the rollback tag answering 503: says traffic is unchanged" "traffic is unchanged" "$out"
assert_no_match "with the rollback tag answering 503: no traffic moves" '--to-revisions' "$calls"
assert_no_match "with the rollback tag answering 503: the daily Job isn't touched" 'warden-daily-expiry' "$calls"
assert_no_match "with the rollback tag answering 503: the Scan Job isn't touched" 'warden-scan' "$calls"

# --- A release moves the traffic while the rollback checks its target: the rollback stops before moving it ---
run_rollback 200 warden-rel-ccccccc-12-1 FAKE_SERVING_LATER=warden-rel-ddddddd-13-1 --
assert_equal "with a release moving the traffic meanwhile: exit 1" 1 "$code"
assert_line "with a release moving the traffic meanwhile: names the new serving revision" "warden-rel-ddddddd-13-1" \
  "$out"
(($(grep -c '^gcloud run services describe ' <<<"$calls") == 2)) ||
  fail "the serving revision isn't read again before the traffic moves"
pass "with a release moving the traffic meanwhile: the serving revision is read again after the tag's health check"
assert_no_match "with a release moving the traffic meanwhile: no traffic moves" '--to-revisions' "$calls"
assert_no_match "with a release moving the traffic meanwhile: the daily Job isn't touched" 'warden-daily-expiry' "$calls"

# --- No release to go back to: traffic stays ---
# no_target <what> <message> [VAR=value...]: a rollback with no revision named that must refuse.
no_target() {
  local what=$1 message=$2
  shift 2
  run_rollback 200 warden-rel-ccccccc-12-1 "$@" --
  assert_equal "$what: exit 1" 1 "$code"
  assert_line "$what: says why" "$message" "$out"
  assert_no_match "$what: no call changes traffic or tags" 'update-traffic' "$calls"
  assert_no_match "$what: the daily Job isn't touched" 'warden-daily-expiry' "$calls"
}
no_target "with no revision tagged previous" "no release is tagged previous" FAKE_PREVIOUS=
no_target "with previous on the serving revision (after a rollback)" "already serving" \
  FAKE_PREVIOUS=warden-rel-ccccccc-12-1
no_target "with previous on a revision that isn't a release" "no release is tagged previous" \
  FAKE_PREVIOUS=warden-00001-xyz
no_target "with traffic split" "name the revision" FAKE_SPLIT=1
no_target "with the serving revision changed since the rollback was asked for" "changed" \
  ROLLBACK_FROM=warden-rel-bbbbbbb-11-1

# --- A named revision that doesn't exist ---
run_rollback 200 warden-rel-ccccccc-12-1 -- warden-rel-zzzzzzz-99-1
assert_equal "a revision that doesn't exist: exit 1" 1 "$code"
assert_line "a revision that doesn't exist: names it" "warden-rel-zzzzzzz-99-1" "$out"
assert_no_match "a revision that doesn't exist: no call changes traffic or tags" 'update-traffic' "$calls"
assert_no_match "a revision that doesn't exist: the daily Job isn't touched" 'warden-daily-expiry' "$calls"

# --- A named revision that isn't a release: Google's placeholder answers 200 anywhere, but can't run the daily Job ---
run_rollback 200 warden-rel-ccccccc-12-1 -- warden-00001-xyz
assert_equal "the placeholder revision by name: exit 1" 1 "$code"
assert_line "the placeholder revision by name: names the rule" "only to a release revision (warden-rel-" "$out"
assert_no_match "the placeholder revision by name: no call changes traffic or tags" 'update-traffic' "$calls"
assert_no_match "the placeholder revision by name: the daily Job isn't touched" 'jobs update' "$calls"
assert_equal "the placeholder revision by name: no gcloud call" "" "$calls"

# --- The service's health check never answers 200 afterwards ---
run_rollback 503 warden-rel-ccccccc-12-1 FAKE_TAG_HEALTH=200 --
assert_equal "with /api/health answering 503 after the move: exit 1" 1 "$code"
assert_line "with /api/health answering 503 after the move: says so" "$service_url/api/health" "$out"
(($(grep -c "^curl .*$service_url" <<<"$calls") > 1)) || fail "the health check didn't retry"
pass "the health check retries before giving up"

# --- Bad input: exit 1 with the usage line, before any gcloud call ---
# bad_input <what> <expected message> [VAR=value...] -- [arguments]
bad_input() {
  local what=$1 message=$2
  shift 2
  run_rollback 200 warden-rel-ccccccc-12-1 "$@"
  assert_equal "$what: exit 1" 1 "$code"
  assert_line "$what: says why" "$message" "$out"
  assert_equal "$what: no gcloud call" "" "$calls"
}
bad_input "two revisions" "usage:" -- warden-rel-aaaaaaa-10-1 warden-rel-bbbbbbb-11-1
bad_input "a flag for a revision" "usage:" -- --to-latest
bad_input "a revision name with a space" "usage:" -- "warden rel"
bad_input "a ROLLBACK_FROM that isn't a revision name" "usage:" "ROLLBACK_FROM=--to-latest" --
bad_input "an unset GCP_PROJECT_ID" "GCP_PROJECT_ID" GCP_PROJECT_ID= --
bad_input "an unset CLOUD_SQL_CONNECTION" "CLOUD_SQL_CONNECTION" CLOUD_SQL_CONNECTION= --

echo "cloud-run-rollback: all passed"
