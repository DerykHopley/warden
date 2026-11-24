#!/usr/bin/env bash
# The Cloud Run rollback script: real runs against a stub gcloud and a stub curl, first on PATH, which record every
# call and answer as each case sets, so nothing reaches Google and no credentials are needed. Stops at the first
# failed assertion, exiting 1.
# Run from anywhere: scripts/test/cloud-run-rollback.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
rollback="$root/scripts/cloud-run-rollback.sh"
project=test-project
registry="europe-west1-docker.pkg.dev/$project/warden/warden"
service_url=https://warden-123456789012.europe-west1.run.app

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
# the setup script, four releases (one with fractional seconds, as Cloud Run writes them), and ddddddd-13, newer than
# the serving one but never given traffic (its health gate failed).
cat >"$scratch/revisions.json" <<JSON
[
  {"metadata":{"name":"warden-rel-bbbbbbb-11","creationTimestamp":"2026-11-26T10:00:00.123456Z"},
   "spec":{"containers":[{"image":"$registry:bbbbbbb"}]}},
  {"metadata":{"name":"warden-rel-ddddddd-13","creationTimestamp":"2026-11-28T10:00:00Z"},
   "spec":{"containers":[{"image":"$registry:ddddddd"}]}},
  {"metadata":{"name":"warden-00001-xyz","creationTimestamp":"2026-11-20T10:00:00Z"},
   "spec":{"containers":[{"image":"us-docker.pkg.dev/cloudrun/container/hello"}]}},
  {"metadata":{"name":"warden-rel-ccccccc-12","creationTimestamp":"2026-11-27T10:00:00Z"},
   "spec":{"containers":[{"image":"$registry:ccccccc"}]}},
  {"metadata":{"name":"warden-rel-aaaaaaa-10","creationTimestamp":"2026-11-25T10:00:00Z"},
   "spec":{"containers":[{"image":"$registry:aaaaaaa"}]}}
]
JSON

# A stub gcloud: records each call, one per line. The service's traffic is all on FAKE_SERVING, or split 50/50
# between FAKE_SERVING and the placeholder with FAKE_SPLIT=1.
cat >"$scratch/gcloud" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")
printf 'gcloud %s\n' "$*" >>"$dir/calls"
case "$*" in
  "run services describe warden "*)
    if [[ ${FAKE_SPLIT-} == 1 ]]; then
      traffic="{\"revisionName\":\"$FAKE_SERVING\",\"percent\":50},{\"revisionName\":\"warden-00001-xyz\",\"percent\":50}"
    else
      traffic="{\"revisionName\":\"$FAKE_SERVING\",\"percent\":100},{\"revisionName\":\"warden-rel-ddddddd-13\",\"tag\":\"candidate\"}"
    fi
    echo "{\"metadata\":{\"name\":\"warden\"},\"status\":{\"url\":\"https://warden-123456789012.europe-west1.run.app\",\"traffic\":[$traffic]}}"
    ;;
  "run revisions list "*) cat "$dir/revisions.json" ;;
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

# run_rollback <health> <serving revision> [VAR=value...] -- [arguments]: the script with only the stubs, /usr/bin
# and /bin on PATH, GCP_PROJECT_ID plus any variable given (VAR= unsets one), no wait between health tries. Its output
# (stdout and stderr) is in $out, its exit code in $code, the stubs' calls in $calls.
run_rollback() {
  local health=$1 serving=$2
  shift 2
  local vars=(GCP_PROJECT_ID="$project")
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
# line_no <fixed prefix>: the line number of the first recorded call containing it.
line_no() { grep -nF -- "$1" <<<"$calls" | head -1 | cut -d: -f1; }

# --- No revision named: back to the newest release older than the serving one ---
run_rollback 200 warden-rel-ccccccc-12 --
[[ $code == 0 ]] || fail "a rollback from ccccccc-12 failed (exit $code): $out"
pass "a rollback from ccccccc-12 exits 0"
traffic=$(call_of "gcloud run services update-traffic warden ")
assert_equal "all traffic goes to bbbbbbb-11, the newest release older than the serving one" \
  "warden-rel-bbbbbbb-11=100" "$(flag to-revisions "$traffic")"
assert_no_match "no call moves traffic to the latest revision" '--to-latest' "$calls"
job=$(call_of "gcloud run jobs update warden-daily-expiry ")
assert_equal "the daily Job runs bbbbbbb-11's image" "$registry:bbbbbbb" "$(flag image "$job")"
(($(line_no "update-traffic") < $(line_no "gcloud run jobs update warden-daily-expiry "))) ||
  fail "the daily Job's image moves before the traffic does"
(($(line_no "gcloud run jobs update") < $(line_no "curl "))) || fail "the health check runs before the Job moves"
pass "traffic moves, then the daily Job's image, then the health check"
assert_line "the health check calls the service's /api/health" "$service_url/api/health" "$calls"
assert_no_match "no call names Cloud Scheduler" '^gcloud scheduler' "$calls"
assert_line "it says where traffic went" "warden-rel-bbbbbbb-11" "$out"

# --- A named revision ---
run_rollback 200 warden-rel-ccccccc-12 -- warden-rel-aaaaaaa-10
assert_equal "a rollback to aaaaaaa-10 by name: exit 0" 0 "$code"
assert_equal "a rollback to aaaaaaa-10 by name: all traffic goes to it" "warden-rel-aaaaaaa-10=100" \
  "$(flag to-revisions "$(call_of "gcloud run services update-traffic warden ")")"
assert_equal "a rollback to aaaaaaa-10 by name: the daily Job runs its image" "$registry:aaaaaaa" \
  "$(flag image "$(call_of "gcloud run jobs update warden-daily-expiry ")")"

# --- No earlier release: traffic stays ---
for serving in warden-rel-aaaaaaa-10 warden-00001-xyz; do
  run_rollback 200 "$serving" --
  assert_equal "from $serving, with no earlier release: exit 1" 1 "$code"
  assert_line "from $serving, with no earlier release: says so" "no release revision older than $serving" "$out"
  assert_no_match "from $serving, with no earlier release: traffic stays" 'update-traffic' "$calls"
  assert_no_match "from $serving, with no earlier release: the daily Job isn't touched" 'warden-daily-expiry' "$calls"
done

# --- Traffic split, no revision named: no single serving revision to go back from ---
run_rollback 200 warden-rel-ccccccc-12 FAKE_SPLIT=1 --
assert_equal "with traffic split and no revision named: exit 1" 1 "$code"
assert_line "with traffic split and no revision named: asks for a revision" "name the revision" "$out"
assert_no_match "with traffic split and no revision named: traffic stays" 'update-traffic' "$calls"

# --- A named revision that doesn't exist ---
run_rollback 200 warden-rel-ccccccc-12 -- warden-rel-zzzzzzz-99
assert_equal "a revision that doesn't exist: exit 1" 1 "$code"
assert_line "a revision that doesn't exist: names it" "warden-rel-zzzzzzz-99" "$out"
assert_no_match "a revision that doesn't exist: traffic stays" 'update-traffic' "$calls"
assert_no_match "a revision that doesn't exist: the daily Job isn't touched" 'warden-daily-expiry' "$calls"

# --- The service's health check never answers 200 afterwards ---
run_rollback 503 warden-rel-ccccccc-12 --
assert_equal "with /api/health answering 503 after the move: exit 1" 1 "$code"
assert_line "with /api/health answering 503 after the move: says so" "/api/health" "$out"
(($(grep -c '^curl ' <<<"$calls") > 1)) || fail "the health check didn't retry"
pass "the health check retries before giving up"

# --- Bad input: exit 1 with the usage line, before any gcloud call ---
# bad_input <what> <expected message> [VAR=value...] -- [arguments]
bad_input() {
  local what=$1 message=$2
  shift 2
  run_rollback 200 warden-rel-ccccccc-12 "$@"
  assert_equal "$what: exit 1" 1 "$code"
  assert_line "$what: says why" "$message" "$out"
  assert_equal "$what: no gcloud call" "" "$calls"
}
bad_input "two revisions" "usage:" -- warden-rel-aaaaaaa-10 warden-rel-bbbbbbb-11
bad_input "a flag for a revision" "usage:" -- --to-latest
bad_input "a revision name with a space" "usage:" -- "warden rel"
bad_input "an unset GCP_PROJECT_ID" "GCP_PROJECT_ID" GCP_PROJECT_ID= --

echo "cloud-run-rollback: all passed"
