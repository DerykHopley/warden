#!/usr/bin/env bash
# The preview workflow's first step, before anything is built: is the branch's name a Cloud Run tag, and are the
# repository variables the deploy reads set?
#
# Usage: scripts/preview-check.sh <branch>     (preview/<name>, as GitHub's github.ref_name gives it)
# Env:   GITHUB_OUTPUT (GitHub Actions sets it), and the five repository variables below.
#
# - A name that isn't 1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a
#   hyphen: an error naming the rule, exit 1. scripts/cloud-run-deploy.sh holds the name to the same rule.
# - Without GCP_PROJECT_ID or GCP_PREVIEW_DEPLOY_SA there's nowhere to deploy (a fork, or before scripts/gcp-setup.sh
#   has run): a notice naming every missing variable, configured=false, exit 0, so the run is green and deploys
#   nothing.
# - With those two but another missing: an error naming every missing one, exit 1, so a half-set-up repository fails
#   here rather than after the build.
# Writes name=<name> and configured=true|false to GITHUB_OUTPUT.
set -euo pipefail

readonly NAME_RULE="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"
readonly VARIABLES=(GCP_PROJECT_ID GCP_PREVIEW_DEPLOY_SA GCP_WIF_PROVIDER CLOUD_SQL_CONNECTION VITE_CLERK_PUBLISHABLE_KEY)

name=${1#preview/}
if [[ ! $name =~ ^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$ ]]; then
  echo "::error::The preview name '$name' must be $NAME_RULE"
  exit 1
fi

missing=()
for var in "${VARIABLES[@]}"; do
  [[ -n ${!var:-} ]] || missing+=("$var")
done
list=$(
  IFS=,
  echo "${missing[*]}"
)
list=${list//,/, }

configured=true
if [[ -z ${GCP_PROJECT_ID:-} || -z ${GCP_PREVIEW_DEPLOY_SA:-} ]]; then
  echo "::notice::No preview deployed: the repository variables $list aren't set (scripts/gcp-setup.sh sets them)"
  configured=false
elif [[ ${#missing[@]} -gt 0 ]]; then
  echo "::error::The preview can't deploy: the repository variables $list aren't set (scripts/gcp-setup.sh sets them)"
  exit 1
fi

{
  echo "name=$name"
  echo "configured=$configured"
} >>"$GITHUB_OUTPUT"
