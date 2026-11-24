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
   migrations), `warden_app` (what the app connects as, bound by row-level security) and `warden_admin` (bypasses
   it, for deliberate cross-Team tasks); it's safe to run again. `migrate` applies the new SQL files in
   `server/migrations`, in file-name order, each in its own transaction; it only goes forwards. It runs only as
   `warden_migrate` (the `.envrc` user `warden` is refused), so every table gets the app's grants. Run it again
   after pulling new migrations.
6. `pnpm dev`: the server on `PORT` (default 8080) and the dashboard on Vite's port (5173), which hands `/api` to
   the server. Open http://localhost:5173. The server runs as `warden_app`, whatever `PGUSER` says: `.envrc`
   keeps `PGUSER=warden` for `roles` and the tests, which need the compose superuser.

The server checks its configuration at start-up and stops, naming the variable, when a required one is missing.
It also stops, naming the role and the reason, when its database role can bypass row-level security: a superuser,
a role with `BYPASSRLS`, or one that can become such a role or a table's owner. It refuses `warden_migrate` and
`warden_admin` by name too, whatever their attributes, as on Cloud SQL `warden_admin` has no `BYPASSRLS`.
When the database can't be reached at start, it stays up and checks the role on the first connection that
succeeds.
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
| Design lint | `pnpm design-lint` |
| Script tests | each `scripts/test/*.test.sh`, run with `bash` (the setup script's in `DRY_RUN=1` and against a fake `gcloud`: nothing reaches Google) |
| Image build | `docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=<key> .` |

The pre-push hook (`.githooks/pre-push`) runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
`pnpm design-lint`.

## Setting up Google Cloud

Warden runs on Cloud Run in `europe-west1`, with Cloud SQL for Postgres 17. `scripts/gcp-setup.sh` sets up the
project once. It's safe to run again: it creates only what's missing, and puts each setting back to the value it
sets.

**Before you run it** you need a Google Cloud project with billing, the
[Google Cloud CLI](https://cloud.google.com/sdk/docs/install), Node 24, and these, made by hand:

- a Cloud SQL for PostgreSQL 17 instance in `europe-west1`;
- the secrets `warden-db-password` (the instance's `postgres` user's password), `warden-clerk-secret`,
  `warden-clerk-publishable` and `warden-clerk-jwt-key`.

**What it makes or sets:**

| Step | What |
|---|---|
| APIs | Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, IAM, STS and IAM Credentials, turned on |
| Artifact Registry | the Docker repository `warden` in `europe-west1` |
| Cloud SQL | the databases `warden` and `warden_preview`; daily backups, 7 kept; point-in-time recovery with 6 days of logs (Cloud SQL's docs ask for fewer log days than backups); no authorized networks, and connectors required |
| Logging | the `_Default` log bucket keeps 30 days; Data Access audit logs (`DATA_READ`) for Secret Manager only, so each read of a secret is recorded |
| Secrets | `warden-db-app-password` and `warden-db-migrate-password`, each a random value piped straight into Secret Manager (never printed or written to a file), stored in `europe-west1` only. It then prints all six secrets' replication |
| Service accounts | `warden-run` (the service): Cloud SQL client, and the Clerk secret, the Clerk JWT key and the app password. `warden-migrate` (the migration jobs): Cloud SQL client, and the three database passwords. `warden-deploy` (GitHub Actions): Cloud Run developer, writer on the `warden` repository, and may act as `warden-run` and `warden-migrate`; it reads no secret. None has a key |
| Workload Identity Federation | the pool `github` and its provider `warden`, which admits only the repository you name, by its numeric id, only a push or a manual dispatch, and only on its `main` and `preview/*` branches; that pool may act as `warden-deploy` |
| The service | Cloud Run service `warden`, with Google's placeholder image, running as `warden-run`, public, at most 2 instances. The script makes it because `warden-deploy` can't make a service public. Run again, it puts the service account, the instance limit and public access back, keeping the image the service runs. Sign-in is Clerk's job |

**Run it.** Below, `<project-id>` is your project, `<instance>` your Cloud SQL instance, and `<owner>/<repo>` the
GitHub repository that deploys (Warden's own: `coherent-bay-515713-r7`, `warden-db` and `DerykHopley/warden`).

1. Sign in, pick the project, and name the repository that may deploy, with its numeric id. The script needs both
   and stops without them:

   ```sh
   gcloud auth login
   gcloud config set project <project-id>
   export WARDEN_GITHUB_REPO=<owner>/<repo>
   export WARDEN_GITHUB_REPO_ID=$(gh api repos/<owner>/<repo> --jq .id)
   ```

2. Dry run first: it prints every `gcloud` command instead of running it, and needs no credentials. A dry run
   assumes nothing exists yet, so it shows everything a first run would do. `DRY_RUN=1` is the only value that
   makes a dry run.

   ```sh
   DRY_RUN=1 scripts/gcp-setup.sh <project-id> <instance>
   ```

3. The run:

   ```sh
   scripts/gcp-setup.sh <project-id> <instance>
   ```

   Before changing anything it checks the instance and the four secrets above exist, and stops naming any that
   don't. A `gcloud` error other than "not found" also stops it, printing the error. Turning on point-in-time
   recovery restarts the instance once (Cloud SQL's docs say so), closing open connections; the script warns
   first, and skips that flag when it's already on.

4. Paste the `gh variable set` lines it prints last. They hold names and ids only, never a secret:
   `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `CLOUD_SQL_CONNECTION` and
   `VITE_CLERK_PUBLISHABLE_KEY`. The publishable key is public by design; its line reads it from your keyring
   when you paste it:

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
