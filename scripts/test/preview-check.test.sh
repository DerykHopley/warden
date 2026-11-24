#!/usr/bin/env bash
# The preview workflow's first step (scripts/preview-check.sh): the branch's name, then the five repository
# variables, before anything is built. Stops at the first failed assertion, exiting 1.
# Run from anywhere: scripts/test/preview-check.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
check="$root/scripts/preview-check.sh"
name_rule="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"

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

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# run_check <branch> [VAR=value...]: the check with all five variables set, less any given empty, and its outputs
# file. Output in $out, exit code in $code, what it wrote to GITHUB_OUTPUT in $outputs.
run_check() {
  local branch=$1
  shift
  : >"$scratch/output"
  set +e
  out=$(env -i PATH=/usr/bin:/bin GITHUB_OUTPUT="$scratch/output" GCP_PROJECT_ID=test-project \
    GCP_PREVIEW_DEPLOY_SA=warden-preview-deploy@test-project.iam.gserviceaccount.com \
    GCP_WIF_PROVIDER=projects/1/locations/global/workloadIdentityPools/github/providers/warden \
    CLOUD_SQL_CONNECTION=test-project:europe-west1:test-db VITE_CLERK_PUBLISHABLE_KEY=pk_test_x \
    "$@" bash "$check" "$branch" 2>&1)
  code=$?
  set -e
  outputs=$(cat "$scratch/output")
}

run_check preview/demo
assert_equal "preview/demo with every variable: exit 0" 0 "$code"
assert_equal "preview/demo with every variable: deploys demo" "name=demo
configured=true" "$outputs"

for bad in Bad_Name a2345678901234567890z 1demo demo- ""; do
  run_check "preview/$bad" GCP_PROJECT_ID=
  assert_equal "preview/$bad: exit 1, even with nothing configured" 1 "$code"
  assert_line "preview/$bad: an error" "::error::" "$out"
  assert_line "preview/$bad: names the rule" "$name_rule" "$out"
done
run_check preview/a234567890123456789z
assert_equal "a 20-character name: exit 0" 0 "$code"

# Not configured (a fork, or before the setup script): a notice naming every missing variable, and a green run.
run_check preview/demo GCP_PROJECT_ID= CLOUD_SQL_CONNECTION=
assert_equal "without GCP_PROJECT_ID: exit 0" 0 "$code"
assert_line "without GCP_PROJECT_ID: a notice" "::notice::" "$out"
assert_line "without GCP_PROJECT_ID: names it" "GCP_PROJECT_ID" "$out"
assert_line "without GCP_PROJECT_ID: names every missing one" "CLOUD_SQL_CONNECTION" "$out"
assert_equal "without GCP_PROJECT_ID: nothing deploys" "name=demo
configured=false" "$outputs"
run_check preview/demo GCP_PREVIEW_DEPLOY_SA=
assert_equal "without GCP_PREVIEW_DEPLOY_SA: exit 0" 0 "$code"
assert_line "without GCP_PREVIEW_DEPLOY_SA: a notice naming it" "::notice::" "$(grep GCP_PREVIEW_DEPLOY_SA <<<"$out")"
assert_line "without GCP_PREVIEW_DEPLOY_SA: nothing deploys" "configured=false" "$outputs"

# Half configured: the deploy would fail later, so the check fails now, before the build, naming each missing one.
run_check preview/demo GCP_WIF_PROVIDER= VITE_CLERK_PUBLISHABLE_KEY=
assert_equal "without GCP_WIF_PROVIDER and the publishable key: exit 1" 1 "$code"
assert_line "without GCP_WIF_PROVIDER and the publishable key: an error naming the first" "GCP_WIF_PROVIDER" \
  "$(grep '::error::' <<<"$out")"
assert_line "without GCP_WIF_PROVIDER and the publishable key: an error naming the second" \
  "VITE_CLERK_PUBLISHABLE_KEY" "$(grep '::error::' <<<"$out")"
run_check preview/demo CLOUD_SQL_CONNECTION=
assert_equal "without CLOUD_SQL_CONNECTION: exit 1" 1 "$code"
assert_line "without CLOUD_SQL_CONNECTION: an error naming it" "CLOUD_SQL_CONNECTION" "$(grep '::error::' <<<"$out")"

echo "preview-check: all passed"
