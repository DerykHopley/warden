# Warden

One app: a Hono server on Node 24 that serves the API under `/api` and the built React dashboard from one origin.
Sign-in is Clerk; the database is Postgres 17 with pgvector.

| Package | What |
|---|---|
| `contracts` | zod schemas for the API bodies, shared by the server and the dashboard |
| `server` | the Hono app, run as TypeScript directly by Node 24 (no build step) |
| `dashboard` | the React app, built with Vite |

## Local setup

You need Node 24, pnpm 10 (`corepack enable pnpm` runs the version `package.json` names), Docker or Podman with compose, `direnv` and
`secret-tool`.

1. Put the Clerk keys in the keyring (once):

   ```sh
   secret-tool store --label "Warden Clerk secret key" service warden-clerk-secret
   secret-tool store --label "Warden Clerk publishable key" service warden-clerk-publishable
   secret-tool store --label "Warden Clerk JWT key" service warden-clerk-jwt-key
   ```

   The JWT key is the JWKS Public Key (PEM) on the Clerk Dashboard's API keys page; with it, the server checks
   session tokens without calling Clerk.

2. `direnv allow`: the committed `.envrc` loads the keys from the keyring and points the `PG*` variables at the
   compose database. `.env.example` lists every variable Warden reads.
3. `docker compose up -d --wait`: Postgres 17 with pgvector on `127.0.0.1:54329`, trust auth (no password).
4. `pnpm install`: also points git's hooks at `.githooks`, so `git push` runs the pre-push checks.
5. Make the database roles, then migrate, against the compose database:

   ```sh
   pnpm --filter @warden/server roles
   PGUSER=warden_migrate pnpm --filter @warden/server migrate
   ```

   `roles` runs as the compose superuser `warden` and makes `warden_migrate` (owns the schema and runs the
   migrations), `warden_app` (what the app connects as, bound by row-level security) and `warden_admin` (no
   `BYPASSRLS`: it lists Team ids, for the daily Job, and reads nothing else); it's safe to run again. `migrate` applies the new SQL files in
   `server/migrations`, in file-name order, each in its own transaction; it only goes forwards. It runs only as
   `warden_migrate` (the `.envrc` user `warden` is refused), so every table gets the app's grants. Run it again
   after pulling new migrations.
6. `pnpm dev`: the server on `PORT` (default 8080) and the dashboard on Vite's port (5173), which hands `/api` to
   the server. Open http://localhost:5173. The server runs as `warden_app`, whatever `PGUSER` says: `.envrc`
   keeps `PGUSER=warden` for `roles` and the tests, which need the compose superuser.

The server checks its configuration at start-up and stops, naming the variable, when a required one is missing.
It also stops, naming the role and the reason, when its database role can bypass row-level security: a superuser,
a role with `BYPASSRLS`, or one that can become such a role or a table's owner. It refuses `warden_migrate` and
`warden_admin` by name too, whatever their attributes.
When the database can't be reached at start, it stays up and checks the role on the first connection that
succeeds.

`WARDEN_SEED_DEMO=1 pnpm --filter @warden/server seed <team-id>` fills one Team with demo Findings, so the Findings
page has something to show: 11 Findings from Guard and Patch on a Repo, a Product, a Device and an Agent session, 7
of them Open (2 Critical), 2 Fixed (one an Unconfirmed fix), 1 Accepted and 1 False positive. The data lives in
`@warden/contracts/demo`, which the dashboard's tests read too. The Team id is its Clerk Organization id (`org_…`, the
Organization switcher's Manage screen shows it), and the Team's Admin must have opened Warden in it first. It runs as
`warden_app` and writes only through the Findings module (Scans, a Spot run, and two decisions made as the Team's
oldest Admin or Lead). Run again, it says the Team is already seeded. It exits 1, writing nothing, for a Team with
Findings of its own, and for one whose demo Findings aren't as it leaves them (a seed cut short); one seed runs per
Team at a time.

It refuses to start without `WARDEN_SEED_DEMO`. On a hosted database (a `PGHOST` other than `127.0.0.1`,
`localhost` or `::1`, or any `PGPASSWORD`), `WARDEN_SEED_DEMO` must be the database's name, and the live database,
`warden`, is always refused. For an owner preview, through the Cloud SQL Auth Proxy:

```sh
cloud-sql-proxy --port 5433 <project-id>:europe-west1:<instance> &
PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=warden_preview PGUSER=warden_preview_app \
  PGPASSWORD="$(gcloud secrets versions access latest --secret warden-db-preview-app-password)" \
  WARDEN_SEED_DEMO=warden_preview node server/src/seed.ts <team-id>
```

`pnpm --filter @warden/server expire` runs the daily Job once against the compose database: as `warden_app`, with
`warden_admin` listing the Teams, it reopens every Accepted Finding whose expiry has passed, and logs one summary
line. `warden_admin`'s one grant is select on `teams (id)`: every other table refuses it. Where `PGPASSWORD` is
set, the Job also needs `WARDEN_ADMIN_PASSWORD`; it never sends the app's password as the admin's.
`GET /api/health` answers 200 when the database answers and offers the `vector` extension, and 503 naming the
failed part otherwise.

## Checks

The fast lane (`.github/workflows/fast-lane.yml`) runs on every pull request into `main` or `spec/**`, and on push
to `main`:

| Check | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| eslint | `pnpm lint` |
| prettier | `pnpm format:check` (`pnpm format` fixes it) |
| `tsc --noEmit`, every package | `pnpm typecheck` |
| vitest, every package | `pnpm test` (the server's tests need the compose Postgres: they make a throwaway database there and drop it after; the `warden` database is left alone) |
| Browser tests (Chromium) | `pnpm e2e` (below) |
| Design lint | `pnpm design-lint` |
| Script tests | each `scripts/test/*.test.sh`, run with `bash` (the setup script's in `DRY_RUN=1` and against a fake `gcloud`: nothing reaches Google) |
| Image build | `docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=<key> .` |

**Browser tests.** `pnpm e2e` runs the Playwright tests in `e2e/` against the real server and a throwaway database.
They need the compose Postgres (as the server's tests do) and Playwright's Chromium, installed once with
`pnpm --filter @warden/e2e exec playwright install chromium`. No Clerk keys are needed, and none is read: the global
setup builds the dashboard in Vite's `e2e` mode, where a stand-in replaces `@clerk/react`, signs session tokens with a
key pair it makes, and starts the server with that key's public half as `CLERK_JWT_KEY`. It opens two Teams through the
API as their Admins and fills them with the demo seed, then drops the database when the tests end. A production build
holds no part of the stand-in (a dashboard test checks). `pnpm e2e --ui` opens Playwright's UI; a failed test leaves
its trace in `e2e/test-results/`.

The pre-push hook (`.githooks/pre-push`) runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
`pnpm design-lint`.

## Setting up Google Cloud

Warden runs on Cloud Run in `europe-west1`, with Cloud SQL for Postgres 17. `scripts/gcp-setup.sh` sets up the
project once. It's safe to run again: it creates only what's missing, and puts each setting back to the value it
sets.

**Before you run it** you need a Google Cloud project with billing, and on your machine:

- the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), signed in, with application-default
  credentials for the Cloud SQL Auth Proxy (`gcloud auth application-default login`). Their quota project must be
  this project, or unset: the proxy's calls are billed there, and another project refuses them. The script checks it
  first; to set it, run `gcloud auth application-default set-quota-project <project-id>`. A
  `GOOGLE_CLOUD_QUOTA_PROJECT` in your environment comes before it for the proxy, so it must be this project too;
- the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy#install), `cloud-sql-proxy`, on
  your `PATH` (`gcloud components install cloud-sql-proxy` installs it);
- Node 24, and the server's dependencies installed (`pnpm install` in this repository): the script runs
  `server/src/roles.ts` itself.

And these, made by hand:

- a Cloud SQL for PostgreSQL 17 instance in `europe-west1`;
- the secrets `warden-db-password` (the instance's `postgres` user's password), `warden-clerk-secret`,
  `warden-clerk-publishable` and `warden-clerk-jwt-key`.

The `postgres` user's password must be the latest version of `warden-db-password`: the roles step logs in with it.
When they differ, the script says so and prints the `gcloud sql users set-password` command that sets it from the
secret.

**Two sets of identities.** Live (`main`) and owner previews (`preview/*` branches) each get their own service
accounts and their own database roles, with their own passwords. A preview runs on the `warden-preview` service and
the `warden_preview` database, and nothing in it can act as a live account or role, or read a live password.

**What it makes or sets:**

| Step | What |
|---|---|
| APIs | Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, IAM, STS, IAM Credentials and Cloud Scheduler, turned on |
| Artifact Registry | the Docker repositories `warden` (releases) and `warden-preview` (owner previews), in `europe-west1` |
| Cloud SQL | the databases `warden` and `warden_preview`; daily backups, 7 kept; point-in-time recovery with 6 days of logs (Cloud SQL's docs ask for fewer log days than backups); no authorized networks, and connectors required |
| Logging | the `_Default` log bucket keeps 30 days; Data Access audit logs (`DATA_READ`) for Secret Manager only, so each read of a secret is recorded |
| Secrets | `warden-db-app-password`, `warden-db-migrate-password`, `warden-db-admin-password`, `warden-db-preview-app-password` and `warden-db-preview-migrate-password`, each a random value piped straight into Secret Manager (never printed or written to a file), stored in `europe-west1` only. It then prints all nine secrets' replication |
| Database roles | run from your machine, as `postgres`, through the Cloud SQL Auth Proxy on a free local port: `server/src/roles.ts` makes the live roles (`warden_migrate`, `warden_app`, `warden_admin`) on `warden`, with their three passwords, then the preview roles (`warden_preview_migrate`, `warden_preview_app`, `warden_preview_admin`) on `warden_preview`, with the app and migrate passwords only: no preview Job runs, so `warden_preview_admin` can't log in. Each database lets only its own set connect. The passwords go from Secret Manager into that one process's environment only; the proxy is stopped when the script ends, also on failure. No service account reads the `postgres` password, so **rerun the script after a change to `createRoles`** |
| Service accounts | none has a key. See the table below |
| Workload Identity Federation | the pool `github` and its provider `warden`, which admits only the repository you name, by its numeric id, only a push or a manual dispatch, and only on its `main` and `preview/*` branches. The provider maps each token to its repository id and branch kind (`attribute.deploy`, such as `<repo-id>:main`): only this repository's `main` tokens may act as `warden-deploy`, and only its `preview/*` tokens as `warden-preview-deploy`, so a token from another repository can never match, even through another provider in the pool |
| The services and the job | Cloud Run services `warden` (as `warden-run`, at most 2 instances) and `warden-preview` (as `warden-preview-run`, at most 1 instance), each public with Google's placeholder image, and the Cloud Run job `warden-migrate-preview` (as `warden-preview-migrate`, with Google's placeholder job image). The script makes them because the deploy accounts can't make a service public, and `warden-preview-deploy`'s roles are on the preview service and job themselves. Run again, it puts each one's service account, instance limit and public access back, keeping the image it runs. Sign-in is Clerk's job |
| The daily Job and its trigger | the Cloud Run job `warden-daily-expiry` (as `warden-daily`, with Google's placeholder job image until a release gives it Warden's), which only `warden-scheduler` may start (`roles/run.invoker` on that Job); then the Cloud Scheduler job `warden-daily-expiry` in `europe-west1`, which runs it daily at `0 4 * * *` (`Etc/UTC`, after the 03:00 backup) by a `POST` to the Job's `:run` URL with an OAuth token as `warden-scheduler`. Run again, it puts the Job's service account back, keeping its image, and updates the Scheduler job to these values. Cloud Scheduler is free for up to 3 jobs per billing account |

**The service accounts and what each may do:**

| Account | Used by | May |
|---|---|---|
| `warden-run` | the `warden` service | Cloud SQL client; read `warden-db-app-password`, `warden-clerk-secret` and `warden-clerk-jwt-key` |
| `warden-migrate` | the live migration job | Cloud SQL client; read `warden-db-app-password` and `warden-db-migrate-password`. Not the `postgres` password |
| `warden-daily` | the daily expiry Job `warden-daily-expiry` (the setup script makes it; #24's release updates its image) | Cloud SQL client; read `warden-db-app-password` and `warden-db-admin-password`. The only account that reads the admin password, so the server can't list Teams |
| `warden-deploy` | GitHub Actions on `main` | Cloud Run developer on the project; writer on the `warden` repository; act as `warden-run`, `warden-migrate` and `warden-daily`. Reads no secret |
| `warden-preview-run` | the `warden-preview` service | Cloud SQL client; read `warden-db-preview-app-password`, `warden-clerk-secret` and `warden-clerk-jwt-key` |
| `warden-preview-migrate` | the `warden-migrate-preview` job | Cloud SQL client; read `warden-db-preview-migrate-password` only |
| `warden-preview-deploy` | GitHub Actions on `preview/*` | Cloud Run developer on the `warden-preview` service and the `warden-migrate-preview` job only, never the project; writer on the `warden-preview` repository only; act as `warden-preview-run` and `warden-preview-migrate` only. Reads no secret |
| `warden-scheduler` | Cloud Scheduler | may start `warden-daily-expiry` (`roles/run.invoker` on that Job), nothing else; reads no secret |

Previews still share the one Clerk secret key with live for now.

**Run it.** Below, `<project-id>` is your project, `<instance>` your Cloud SQL instance, and `<owner>/<repo>` the
GitHub repository that deploys (Warden's own: `coherent-bay-515713-r7`, `warden-db` and `DerykHopley/warden`).

1. Sign in, pick the project, and name the repository that may deploy, with its numeric id. The script needs both
   and stops without them:

   ```sh
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project <project-id>
   gcloud components install cloud-sql-proxy
   pnpm install
   export WARDEN_GITHUB_REPO=<owner>/<repo>
   export WARDEN_GITHUB_REPO_ID=$(gh api repos/<owner>/<repo> --jq .id)
   ```

2. Dry run first: it prints every command instead of running it, and needs no credentials. A dry run assumes
   nothing exists yet, so it shows everything a first run would do; the roles step shows `<from warden-db-…>` in
   place of each password. `DRY_RUN=1` is a dry run; unset, empty or `DRY_RUN=0` is a real run; any other value
   (`true`, `yes`) stops the script before it does anything.

   ```sh
   DRY_RUN=1 scripts/gcp-setup.sh <project-id> <instance>
   ```

3. The run:

   ```sh
   scripts/gcp-setup.sh <project-id> <instance>
   ```

   Before changing anything it checks `cloud-sql-proxy`, the server's dependencies, the application-default
   credentials, the instance and the four secrets above, and stops naming any that's missing. A `gcloud` error
   other than "not found" also stops it, printing the error, and so does a failed roles run, with the roles
   script's own error (which holds no password). Turning on point-in-time recovery restarts the instance once
   (Cloud SQL's docs say so), closing open connections; the script warns first, and skips that flag when it's
   already on.

4. Paste the `gh variable set` lines it prints last. They hold names and ids only, never a secret:
   `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `GCP_PREVIEW_DEPLOY_SA` (the preview workflow's
   account), `CLOUD_SQL_CONNECTION` and `VITE_CLERK_PUBLISHABLE_KEY`. The publishable key is public by design; its
   line reads it from your keyring when you paste it:

   ```sh
   gh variable set VITE_CLERK_PUBLISHABLE_KEY --body "$(secret-tool lookup service warden-clerk-publishable)" --repo <owner>/<repo>
   ```

**Why the database keeps a public IP.** A private IP needs a VPC network, private services access and Direct VPC
egress, and Warden has none of them. Instead the instance has no authorized networks, so no address can reach it
directly, and connector enforcement is on, so only the Cloud SQL Auth Proxy and Google's Cloud SQL connectors can
connect, each authorized by IAM. Cloud Run's built-in Cloud SQL connection is the Auth Proxy. The script prints the
instance's IP configuration at the end.

With connectors required, `gcloud sql connect` stops working. To reach the database yourself, run the
[Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy):
`cloud-sql-proxy --port 5433 <project-id>:europe-west1:<instance>`, then `psql -h 127.0.0.1 -p 5433 -U postgres`.

## The image

`Dockerfile` builds the dashboard (it needs `VITE_CLERK_PUBLISHABLE_KEY` as a build argument and fails without it)
and runs the server as the non-root `node` user on `PORT`. The server reads the same variables at run time.

On Cloud Run (where Cloud Run sets `K_SERVICE`), the server also needs `CLERK_AUTHORIZED_PARTIES`: the dashboard
origins Warden is served from, comma-separated, such as `https://warden-abc123-ew.a.run.app`. A Clerk session token
signs someone in only when it was made for one of them, so a token from another app on the same Clerk instance is
refused. Without it there the server stops at start, naming the variable. Locally it defaults to the dashboard's
`http://localhost:5173`. Cloud Run also decides the client address the sign-in limit counts: the last
`X-Forwarded-For` entry, which holds while Warden is reached at its own run.app URL; a load balancer in front would
need that changed (`docs/threat-model.md`, A5).

## Owner previews

An owner preview is a running copy of any commit, on its own URL, for the owner to try before it reaches `main`. It
runs on the `warden-preview` service and the `warden_preview` database, as the preview accounts only: nothing in it
touches the live service, its traffic or its data. It needs Google Cloud set up first (above).

**Deploy one** by pushing the commit to a branch named `preview/<name>`:

```sh
git push origin <commit>:refs/heads/preview/<name>
```

`<name>` becomes the preview's Cloud Run tag, so it must be **1 to 20 lowercase letters, digits and hyphens,
starting with a letter and not ending in a hyphen** (`foundation`, `sign-in-fix`). Push again to the same branch to
replace the preview.

**What the deploy does** (`.github/workflows/preview.yml`, then `scripts/cloud-run-deploy.sh <image> preview
<name>`):

1. **Check** (`scripts/preview-check.sh`), before anything is built: the name must follow the rule above, and the
   repository variables `GCP_PROJECT_ID`, `GCP_PREVIEW_DEPLOY_SA`, `GCP_WIF_PROVIDER`, `CLOUD_SQL_CONNECTION` and
   `VITE_CLERK_PUBLISHABLE_KEY` must be set. Without `GCP_PROJECT_ID` or `GCP_PREVIEW_DEPLOY_SA`, the run deploys
   nothing and stays green, with a notice naming every missing variable. With those two but another missing, it
   fails, naming each.
2. **Build** the image, with no Google credentials.
3. Sign in to Google Cloud through Workload Identity Federation (no key) as `warden-preview-deploy`, and push the
   image to the `warden-preview` repository, tagged with the commit.
4. **Migrate:** deploy the `warden-migrate-preview` job with the image, as `warden-preview-migrate`, run
   `node server/src/migrate.ts` on `warden_preview` and wait for it. A failed migration stops the deploy before any
   revision exists.
5. **Deploy:** a `warden-preview` revision named `warden-preview-pre-<name>-<sha7>-<run>-<attempt>`, as
   `warden-preview-run`, tagged `<name>`, with **no traffic**. Every run sets the revision's env vars and secrets
   afresh, so none carries over from an earlier revision.
6. **Health gate:** call `/api/health` on the tag's URL for up to about 90 seconds (a cold start) until it answers
   200, or fail the run.

**One at a time.** Previews share the database, so steps 3 to 6 run for one preview at a time, and a running one is
never cancelled halfway. Builds run side by side. While one preview deploys, GitHub keeps only the newest waiting
behind it: an older waiting preview is cancelled (the run shows it) and must be pushed again.

**Its URL** is `https://<name>---warden-preview-<project-number>.europe-west1.run.app`. The run prints it at the end
of the deploy step's log and on the run's summary page. Sign-in uses Clerk's development instance.

**Secrets are pinned.** The revision and the job read their passwords and Clerk keys from Secret Manager by version
number, never `latest`. The numbers live in `secret_version` in `scripts/cloud-run-deploy.sh`. To move one: add the
new version (`gcloud secrets versions add <secret> --data-file=-`), change its number there in a PR, merge it, then
push a preview. Disable the old version only after no running revision reads it.

**Logs:** the workflow run on GitHub (Actions, "Preview"); the migration job's executions
(`gcloud run jobs executions list --job warden-migrate-preview --region europe-west1`) and their logs; and the
revision's own logs in Cloud Logging
(`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="warden-preview"'`).
Warden's request lines hold no address, except on a refused sign-in (`clientAddress`, the address the sign-in limit
counted).

The preview's data stays in `warden_preview`: seed it as "Local setup" shows. Old tags and revisions aren't cleaned
up yet.
