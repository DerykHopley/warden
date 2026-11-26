#!/usr/bin/env bash
# Deploys one Warden image to Cloud Run, in three steps: migrate the database and load Patch's CVE snapshot with a
# Cloud Run job, deploy a revision with the whole configuration set afresh, and wait for its /api/health to answer
# 200. Each mode first checks that its Scan Job is there, and gives that Job the image: a preview after the migration,
# before its revision; a release after the health gate. A release then moves all of the service's traffic to the
# revision, and gives the daily Job the image. README.md's "Owner previews" and "Releasing" say when each runs and what
# it shows.
#
# Usage: scripts/cloud-run-deploy.sh <image> preview <name>
#        scripts/cloud-run-deploy.sh <image> release
#        preview <name>: the warden-preview service, a revision tagged <name> that gets no traffic, on the
#        warden_preview database, as the preview accounts only; after the migration and before the revision, the
#        preview Scan Job warden-scan-preview's image (every preview shares the one Job, so it runs the last preview's
#        image). It prints the tagged URL in its deterministic form,
#        https://<name>---warden-preview-<project-number>.europe-west1.run.app, the one to open and register on the
#        GitHub app. <name> is a Cloud Run tag: 1 to 20 lowercase letters, digits and hyphens, starting with a letter
#        and not ending in a hyphen (20 keeps the revision name short).
#        release: the warden service, a revision tagged candidate on the warden database, as the live accounts only;
#        after its health gate, the Scan Job warden-scan's image, then 100% of traffic by revision name (the release
#        it replaces tagged previous, for a rollback), then the daily Job warden-daily-expiry's image. Run in a
#        checkout with main's whole history: it releases only a commit on main that is newer than the serving
#        release's (release_order).
#        Each mode's revision names its Scan Job in WARDEN_SCAN_JOB.
# Env:   GCP_PROJECT_ID, CLOUD_SQL_CONNECTION (<project>:<region>:<instance>), VITE_CLERK_PUBLISHABLE_KEY (public) and
#        WARDEN_GITHUB_APP_CLIENT_ID (the read-only GitHub app's client id, public; a preview shares the live app),
#        all required; GITHUB_SHA and GITHUB_RUN_NUMBER (required) and GITHUB_RUN_ATTEMPT (default 1), which GitHub
#        Actions sets, name the revision. HEALTH_ATTEMPTS and HEALTH_INTERVAL (seconds) bound the health gate.
# Needs: gcloud signed in as an account that may deploy the mode's job and service and act as its accounts; curl; jq;
#        git, for a release.
# The secret versions it pins, and what it shares with the rollback, are in scripts/lib/cloud-run.sh.
set -euo pipefail

readonly PROGRAM=cloud-run-deploy
readonly USAGE="usage: scripts/cloud-run-deploy.sh <image> preview <name> | <image> release"
readonly NAME_RULE="1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen"
# shellcheck source-path=SCRIPTDIR source=lib/cloud-run.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/cloud-run.sh"

# One table of names per mode: the service and its account, the migration job and its account, the Scan Job and its
# account, the database, its role set and roles, the two password secrets, the revision suffix's start, and which of
# the service's URLs a Clerk session token may be made for (PARTIES_FROM: the tag's, for a preview reached only there;
# the service's own, for a release that takes the traffic).
names_for() {
  case $1 in
    preview)
      SERVICE=warden-preview
      RUN_ACCOUNT=warden-preview-run
      JOB=warden-migrate-preview
      MIGRATE_ACCOUNT=warden-preview-migrate
      MODE_SCAN_JOB=warden-scan-preview
      MODE_SCAN_ACCOUNT=warden-preview-scan
      DATABASE=warden_preview
      DATABASE_ROLES=preview
      APP_USER=warden_preview_app
      MIGRATE_USER=warden_preview_migrate
      APP_PASSWORD_SECRET=warden-db-preview-app-password
      MIGRATE_PASSWORD_SECRET=warden-db-preview-migrate-password
      SUFFIX_START=pre-$TAG
      PARTIES_FROM=tagged
      ;;
    release)
      SERVICE=warden
      RUN_ACCOUNT=warden-run
      JOB=warden-migrate
      MIGRATE_ACCOUNT=warden-migrate
      MODE_SCAN_JOB=$SCAN_JOB
      MODE_SCAN_ACCOUNT=$SCAN_ACCOUNT
      DATABASE=warden
      DATABASE_ROLES=live
      APP_USER=warden_app
      MIGRATE_USER=warden_migrate
      APP_PASSWORD_SECRET=warden-db-app-password
      MIGRATE_PASSWORD_SECRET=warden-db-migrate-password
      SUFFIX_START=rel
      PARTIES_FROM=service
      ;;
  esac
}
readonly CLERK_SECRET=warden-clerk-secret
readonly CLERK_JWT_SECRET=warden-clerk-jwt-key
# The read-only GitHub app's (#132), which a preview shares (#275).
readonly GITHUB_APP_CLIENT_SECRET=warden-github-app-client-secret
readonly GITHUB_APP_PRIVATE_KEY=warden-github-app-private-key
# The migration job's one execution: the migrations, then Patch's CVE snapshot (README.md's "CVE data"). A failure in
# either fails the job, so no revision is deployed. gcloud splits --args at commas, so this holds none.
readonly MIGRATE_COMMAND="node server/src/migrate.ts && node server/src/modules/patch/cve-snapshot.ts"

migrate() {
  local password
  password=$(pinned "$MIGRATE_PASSWORD_SECRET") || exit 1
  gcloud run jobs deploy "$JOB" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$MIGRATE_ACCOUNT@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --command=sh \
    --args="-c,$MIGRATE_COMMAND" \
    --max-retries=0 \
    --set-env-vars="$(dict "PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" "WARDEN_DATABASE_ROLES=$DATABASE_ROLES" \
      "PGUSER=$MIGRATE_USER" "PGDATABASE=$DATABASE")" \
    --set-secrets="$(dict "PGPASSWORD=$password")" \
    --project="$GCP_PROJECT_ID"
  gcloud run jobs execute "$JOB" --region="$REGION" --wait --project="$GCP_PROJECT_ID" ||
    fail "the migration job $JOB failed; no revision was deployed"
}

deploy_revision() {
  local parties=$1 password clerk_secret clerk_jwt github_secret github_key env secrets
  password=$(pinned "$APP_PASSWORD_SECRET") || exit 1
  clerk_secret=$(pinned "$CLERK_SECRET") || exit 1
  clerk_jwt=$(pinned "$CLERK_JWT_SECRET") || exit 1
  github_secret=$(pinned "$GITHUB_APP_CLIENT_SECRET") || exit 1
  github_key=$(pinned "$GITHUB_APP_PRIVATE_KEY") || exit 1
  # The revision starts Scans on its mode's Scan Job, and links GitHub installations with the read-only app.
  env=("PGHOST=/cloudsql/$CLOUD_SQL_CONNECTION" "PGUSER=$APP_USER" "PGDATABASE=$DATABASE"
    "VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY" "CLERK_AUTHORIZED_PARTIES=$parties"
    "WARDEN_SCAN_JOB=$(scan_job_name "$MODE_SCAN_JOB")" "GITHUB_APP_CLIENT_ID=$WARDEN_GITHUB_APP_CLIENT_ID")
  secrets=("PGPASSWORD=$password" "CLERK_SECRET_KEY=$clerk_secret" "CLERK_JWT_KEY=$clerk_jwt"
    "GITHUB_APP_CLIENT_SECRET=$github_secret" "GITHUB_APP_PRIVATE_KEY=$github_key")
  gcloud run deploy "$SERVICE" \
    --image="$IMAGE" \
    --region="$REGION" \
    --no-traffic \
    --tag="$TAG" \
    --revision-suffix="$SUFFIX" \
    --service-account="$RUN_ACCOUNT@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --set-env-vars="$(dict "${env[@]}")" \
    --set-secrets="$(dict "${secrets[@]}")" \
    --project="$GCP_PROJECT_ID"
}

# Release only: whether this commit releases, from the checkout's history (the workflow checks out all of it) and
# <serving>, the revision with the traffic now. Prints `release`; `job` when a release of this same commit serves
# already (a re-run after the daily Job's update failed: only the Job is set); or `skip` when a release of a newer
# commit serves (this run's full lane finished after a later one's). A serving revision that isn't a release, or whose
# commit isn't in the history, doesn't stop a release. Fails when this commit isn't on main's tip's history.
release_order() {
  local served
  git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main || fail "couldn't fetch main from origin"
  git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main 2>/dev/null ||
    fail "$GITHUB_SHA isn't on main; nothing was released"
  if [[ $1 =~ ^${RELEASE_PREFIX}([0-9a-f]{7})- ]] &&
    served=$(git rev-parse --verify --quiet "${BASH_REMATCH[1]}^{commit}"); then
    if [[ $served == "$GITHUB_SHA" ]]; then
      echo job
      return 0
    fi
    if git merge-base --is-ancestor "$GITHUB_SHA" "$served"; then
      echo skip
      return 0
    fi
  fi
  echo release
}

# Release only: 100% of the service's traffic to the new revision, by its name (never --to-latest, which would follow
# whatever revision is newest). In the same call, the revision that had the traffic is tagged previous when it's a
# release, so only a revision that served is ever a rollback's default target; when it isn't (after a rollback by name
# to another revision), an older previous tag is removed, so it can't send a rollback to a stale release. Tags move no
# traffic. <description> is the service's, read before the deploy.
move_traffic() {
  local serving tags=()
  serving=$(serving_revision "$1")
  if [[ $serving == "$RELEASE_PREFIX"* ]]; then
    tags=(--update-tags="previous=$serving")
  elif [[ -n $(jq -r '.status.traffic[]? | select(.tag == "previous") | .revisionName' <<<"$1") ]]; then
    tags=(--remove-tags=previous)
  fi
  gcloud run services update-traffic "$SERVICE" \
    --to-revisions="$SERVICE-$SUFFIX=100" \
    ${tags[@]+"${tags[@]}"} \
    --region="$REGION" \
    --project="$GCP_PROJECT_ID"
}

main() {
  [[ $# -ge 2 && -n $1 ]] || usage_error "give an image and a mode"
  IMAGE=$1
  local mode=$2
  case $mode in
    preview)
      [[ $# -eq 3 ]] || usage_error "preview takes one name"
      TAG=$3
      [[ $TAG =~ ^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$ ]] ||
        usage_error "the preview name '$TAG' must be $NAME_RULE"
      ;;
    release)
      [[ $# -eq 2 ]] || usage_error "release takes no name"
      TAG=candidate
      ;;
    *) usage_error "the mode must be preview or release, not '$mode'" ;;
  esac
  local var required=(GCP_PROJECT_ID CLOUD_SQL_CONNECTION VITE_CLERK_PUBLISHABLE_KEY WARDEN_GITHUB_APP_CLIENT_ID
    GITHUB_SHA GITHUB_RUN_NUMBER)
  for var in "${required[@]}"; do
    [[ -n ${!var:-} ]] || usage_error "set $var"
  done
  names_for "$mode"
  SUFFIX="$SUFFIX_START-${GITHUB_SHA:0:7}-$GITHUB_RUN_NUMBER-${GITHUB_RUN_ATTEMPT:-1}"

  # The service's URLs and serving revision, read before the deploy: the revision's CLERK_AUTHORIZED_PARTIES must
  # name the URLs it's reached at. The tagged URL to open is the deterministic one, from the project number in the
  # service's deterministic URL (https://<service>-<project-number>.<region>.run.app): the one the README tells the
  # owner to register on the GitHub app. status.url is usually that one, but its hash form is a URL too.
  local described service=() tagged=() url open_url=
  described=$(describe_service "$SERVICE") || fail "couldn't read $SERVICE's URLs"
  while IFS= read -r url; do
    if [[ -n $url ]]; then
      service+=("$url")
      tagged+=("$(tag_url "$TAG" "$url")")
      if [[ -z $open_url && $url =~ ^https://$SERVICE-[0-9]+\.$REGION\.run\.app$ ]]; then
        open_url=$(tag_url "$TAG" "$url")
      fi
    fi
  done < <(service_urls "$described")
  [[ ${#service[@]} -gt 0 ]] || fail "$SERVICE reports no URL"
  open_url=${open_url:-${tagged[0]}}
  local parties
  parties=$(
    IFS=,
    list="${PARTIES_FROM}[*]"
    echo "${!list}"
  )

  if [[ $mode == release ]]; then
    local serving order
    serving=$(serving_revision "$described")
    order=$(release_order "$serving") || exit 1
    case $order in
      skip)
        say "Skipped: \`$serving\`, from a newer commit than $GITHUB_SHA, is serving; nothing to release."
        return 0
        ;;
      job)
        update_daily_job "$IMAGE" || fail "updating the daily Job $DAILY_JOB failed; it still runs an older image"
        update_scan_job "$IMAGE" || fail "updating the Scan Job $SCAN_JOB failed; it still runs an older image"
        say "\`$serving\`, from this commit, is already serving; only $DAILY_JOB and $SCAN_JOB were set to its image."
        return 0
        ;;
    esac
  fi

  # The revision names its Scan Job, so the run stops before changing anything when the Job isn't there.
  gcloud run jobs describe "$MODE_SCAN_JOB" --region="$REGION" --project="$GCP_PROJECT_ID" >/dev/null ||
    fail "the Scan Job $MODE_SCAN_JOB isn't there: rerun scripts/gcp-setup.sh. Nothing was migrated or deployed"

  migrate
  # A preview's Scan Job gets the image before the revision, whose tagged URL can start Scans as soon as it's up.
  if [[ $mode == preview ]]; then
    update_scan_job "$IMAGE" preview "$MODE_SCAN_JOB" "$MODE_SCAN_ACCOUNT" "$DATABASE" "$APP_USER" \
      "$APP_PASSWORD_SECRET" ||
      fail "updating the Scan Job $MODE_SCAN_JOB failed, so no revision was deployed. Push to the branch again"
  fi
  deploy_revision "$parties"
  wait_for_health "${tagged[0]}" || fail "the revision gets no traffic"

  if [[ $mode == preview ]]; then
    say "Preview \`$TAG\` is up, with no traffic: $open_url. $MODE_SCAN_JOB runs its image."
    return 0
  fi
  update_scan_job "$IMAGE" ||
    fail "updating the Scan Job $SCAN_JOB failed, so no traffic moved to $SERVICE-$SUFFIX. Dispatch the release again"
  move_traffic "$described"
  update_daily_job "$IMAGE" ||
    fail "traffic moved to $SERVICE-$SUFFIX, but updating the daily Job $DAILY_JOB failed; it still runs the previous image. Dispatch the release again, or set it by hand (README.md, Releasing)"
  say "Released \`$SERVICE-$SUFFIX\`: it has 100% of traffic at ${service[0]}, and $DAILY_JOB and $SCAN_JOB run its image."
}

main "$@"
