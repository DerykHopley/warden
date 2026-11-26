#!/usr/bin/env bash
# The pre-push hook (.githooks/pre-push): a push that only deletes remote branches sends no code and skips the
# checks; a push carrying any commits runs every one. A stand-in pnpm records each call. Stops at the first failed
# assertion, exiting 1.
# Run from anywhere: scripts/test/pre-push.test.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
hook="$root/.githooks/pre-push"

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

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
printf '#!/bin/sh\necho "$*" >>"%s/calls"\n' "$scratch" >"$scratch/bin/pnpm"
chmod +x "$scratch/bin/pnpm"

zero=0000000000000000000000000000000000000000
sha=1111111111111111111111111111111111111111
other=2222222222222222222222222222222222222222
checks="lint
format:check
typecheck
design-lint"

# run_hook <stdin>: the hook as git runs it, one line per ref on stdin. Exit code in $code, pnpm's calls in $calls.
run_hook() {
  : >"$scratch/calls"
  set +e
  printf '%s' "$1" | env -i PATH="$scratch/bin:/usr/bin:/bin" sh "$hook" >/dev/null 2>&1
  code=$?
  set -e
  calls=$(cat "$scratch/calls")
}

run_hook "(delete) $zero refs/heads/old $sha
"
assert_equal "deleting one branch: exit 0" 0 "$code"
assert_equal "deleting one branch: no checks" "" "$calls"

run_hook "(delete) $zero refs/heads/old $sha
(delete) $zero refs/heads/older $other
"
assert_equal "deleting two branches: exit 0" 0 "$code"
assert_equal "deleting two branches: no checks" "" "$calls"

run_hook "(delete) ${zero}${zero:0:24} refs/heads/old ${sha}${sha:0:24}
"
assert_equal "deleting a branch in a SHA-256 repository: no checks" "" "$calls"

run_hook "refs/heads/fix $sha refs/heads/fix $other
"
assert_equal "updating a branch: exit 0" 0 "$code"
assert_equal "updating a branch: every check" "$checks" "$calls"

run_hook "refs/heads/new $sha refs/heads/new $zero
"
assert_equal "pushing a new branch: every check" "$checks" "$calls"

run_hook "(delete) $zero refs/heads/old $sha
refs/heads/fix $sha refs/heads/fix $other
"
assert_equal "deleting one branch and updating another: every check" "$checks" "$calls"

run_hook ""
assert_equal "no refs on stdin: every check" "$checks" "$calls"

echo "pre-push: all passed"
