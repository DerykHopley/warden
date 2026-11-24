#!/usr/bin/env bash
# The ticket's (#14) leftover check, independent of down.sh's own listing: the seven gcloud list commands, each
# filtered for spike-long-work. Fails if any name matches. Read-only.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
start_log leftover-check

commands=(
  "run services list --region=$REGION --format=value(metadata.name)"
  "run jobs list --region=$REGION --format=value(metadata.name)"
  "tasks queues list --location=$REGION --format=value(name)"
  "scheduler jobs list --location=$REGION --format=value(name)"
  "secrets list --format=value(name)"
  "artifacts repositories list --location=$REGION --format=value(name)"
  "iam service-accounts list --format=value(email)"
)
found=0
for command in "${commands[@]}"; do
  # shellcheck disable=SC2086 # each command is split into gcloud's arguments on purpose
  out=$(gcloud $command 2>/dev/null)
  matching=$(grep -c "$PREFIX" <<<"$out" || true)
  total=$(grep -c . <<<"$out" || true)
  say "gcloud $command: $matching named $PREFIX, $total in all"
  if ((matching > 0)); then
    grep "$PREFIX" <<<"$out"
    found=1
  fi
done
if ((found)); then
  say "FAILED: spike resources are left"
  exit 1
fi
say "Nothing named $PREFIX is left."
