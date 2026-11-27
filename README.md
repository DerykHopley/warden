# Warden

Warden is a security and compliance suite for teams that build software with AI coding agents. Its goal: keep that
software safe, and prove it at an audit. Agents read secrets, run commands and add Dependencies faster than anyone can
review them. Guard scans a Team's Repos for risky agent configuration and leaked secrets, and its Judge reads Agent
sessions for risky behaviour. Patch matches each Product's Dependencies against known vulnerabilities. A Scan raises
Findings, one per problem on one Asset; for risky agent configuration, Warden can open a Fix PR that a person merges.
Vouch turns Findings into a Verdict for each Control in a Catalogue, such as VDA ISA 2027.1, so a Lead sees the Gaps
before the audit.

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
5. Make the database roles, migrate, then load the CVE snapshot, against the compose database:

   ```sh
   pnpm --filter @warden/server roles
   PGUSER=warden_migrate pnpm --filter @warden/server migrate
   PGUSER=warden_migrate pnpm --filter @warden/server load-cves
   ```

   `roles` runs as the compose superuser `warden` and makes `warden_migrate` (owns the schema and runs the
   migrations), `warden_app` (what the app connects as, bound by row-level security) and `warden_admin` (no
   `BYPASSRLS`: it lists Team ids, for the daily Job, and reads nothing else); it's safe to run again. `migrate` applies the new SQL files in
   `server/migrations`, in file-name order, each in its own transaction; it only goes forwards. It runs only as
   `warden_migrate` (the `.envrc` user `warden` is refused), so every table gets the app's grants. Run it again
   after pulling new migrations. `load-cves` fills Patch's CVE tables from the snapshot (see "CVE data"), also only
   as `warden_migrate`; run it after `migrate`. A second run with the same files changes nothing.
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
of them Open (2 Critical), 2 Fixed (one an Unconfirmed fix), 1 Accepted and 1 False positive. Then it adds the demo
Product, "Shop web" (the demo Repo, LangChain 0.0.200), and runs its Patch Scan as a save does, so the Products page
has a Product and the Findings page has its CVE Findings from the loaded CVE snapshot (how many depends on the
snapshot). Then it gives the Team VDA ISA 2027.1 (see "Vouch"), as an Admin and a Lead would: it links the demo Repo
as one of the Team's Repo Assets under a made-up GitHub installation, turns ISA2027 on, and confirms the Verdicts of
1.3.4, 4.1.3 and 5.2.4. That gives one Evidenced Control (5.2.4), 2 Gaps (1.3.4 and 4.1.3) and 1.3.3 waiting for a
Lead's review, so the Overview answers "Not yet: 2 Gaps, 1 Control waiting for review.". As the installation is made
up, a Guard Scan of the demo Repo from Setup fails at GitHub. The demo's Scans and Spot run age: about 30 days after
the seed they fall out of the period Vouch reads, its Controls read Not evidenced, the ones reviewed at another Verdict
read "Changed since review", and a rerun won't change that (it never reviews a Control twice), so a fresh demo needs a
fresh Team. Load the snapshot first, once per database:

```sh
PGUSER=warden_migrate pnpm --filter @warden/server load-cves
```

The data lives in `@warden/contracts/demo`, which the dashboard's tests read too. The Team id is its Clerk
Organization id (`org_…`, the Organization switcher's Manage screen shows it), and the Team's Admin must have opened
Warden in it first. It runs as `warden_app` and writes only through the Findings module, the Products store, Guard's
Repo Assets store and Vouch's Catalogue and review stores (Scans, a Spot run, two decisions, the Product and its Scan,
the demo Repo's link, ISA2027's switch and three reviews, each made as the Team's oldest Admin or Lead). Run again, it
says the Team is already seeded; on a Team seeded without the demo Product (with `--no-product`, or before the seed
made one), it adds the Product and runs its Scan, and on one seeded without the ISA2027 state (before the seed wrote
it, or a run cut short) it adds what's missing. That rerun works out the Verdicts it confirms as of today, not as of the
first seed: on a Team seeded more than about 30 days before, whose demo Scans and Spot run are out of the period Vouch
reads, it confirms 1.3.4, 4.1.3 and 5.2.4 at Not evidenced, so the Team has 3 Gaps rather than an Evidenced Control
and 2 Gaps, and no later rerun changes that. For the demo, seed a fresh Team. It never changes ISA2027's switch once
the Team has one (an Admin may have turned it off), nor reviews a Control that has a review, and a Repo the Team linked
itself counts in the Verdicts too: the answer above holds only on a fresh Team. If another Team holds the demo
installation, it exits 1 ("demo seed failed", naming `InstallationLinkedElsewhere`); a rerun after the cause is
fixed (the other Team's link of that installation removed) finishes the Vouch step. A rerun takes the seeded Team's demo
Findings as they are: decisions made on them since (a Lead's, or the daily Job reopening an expired acceptance) and demo
Findings stored under an older demo Rule id are no mismatch, and it changes none of them. It exits 1, writing nothing,
for a Team with Findings of its own, for a Team with Products of its own, and when the CVE snapshot isn't loaded (naming
`load-cves`). On a Team it has seeded before, it also exits 1, writing nothing, for a seed cut short (not every demo run
applied, or the seed's two decisions missing), a demo Product changed since or a Product of the Lead's under its name,
and any Finding the seed didn't write (one from a real Scan, or the CVE Findings a deleted demo Product left). One seed
runs per Team at a time. `--no-product` after the Team id seeds the demo Findings only, with no Product, no snapshot
needed, and none of the ISA2027 state (no Repo Asset, Catalogue choice or review): the browser tests seed Acme and
Bluebird that way.

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
`warden_admin` listing the Teams, it reopens every Accepted Finding whose expiry has passed, refreshes Patch's CVE
Findings (one Patch Scan per Product, against the loaded CVE snapshot, plus the Findings of a deleted Product), and
logs one summary line. Before `load-cves` has run, each Patch Scan fails without changing a Finding, so the Job exits
1 when any Team has a Product, or a deleted Product's Findings, to scan. `warden_admin`'s one grant is select on
`teams (id)`: every other table refuses it. Where `PGPASSWORD` is set, the Job also needs `WARDEN_ADMIN_PASSWORD`; it
never sends the app's password as the admin's.
`GET /api/health` answers 200 when the database answers and offers the `vector` extension, and 503 naming the
failed part otherwise.

## Connecting GitHub

An Admin links the Team's repos once, from the dashboard. Warden needs its GitHub app's settings first (a Warden
without them says "GitHub isn't set up on this Warden." on Setup), and the app's Setup URL and callback URL on GitHub
must be this Warden's `/setup/github` and `/setup/github/callback`.

1. Open **Setup** in the header, and choose **Install the GitHub app**.
2. On GitHub, install the app on the account or organization, for all repos or the ones Warden should scan. GitHub
   sends you back to Warden's Connect GitHub page, which names the installation and the Team.
3. Choose **Sign in with GitHub**, and authorize the app. Warden checks, with your own sign-in, that you can reach the
   installation, and links the repos you can read in it. The page says how many; Setup lists them under Repos.

Only an Admin connects GitHub: a Lead or a Member sees the Team's repos on Setup, and "An Admin connects GitHub.".
The sign-in must start and end in the same browser tab: Warden keeps the sign-in's check there until GitHub sends you
back. An installation links to one Team only.

Once the repos are linked, Setup shows each one's last Scan beside it: Never scanned, Queued, Running, or Done or
Failed with the day and time it ended. A Lead or an Admin starts a Guard Scan of the listed repos (the first 100) with
**Scan now**; the list follows it without a reload, and the button waits while a Scan is under way. A Member sees each
repo's last Scan, and no button.

### Granting write access

Fix PRs go through a second GitHub app, the write app, apart from the read-only one. Until Warden has its settings, Setup's "Grant write access" section says "Fix PRs aren't set up on this
Warden." and shows an Admin these steps, open, under "How to set up the write app", with this Warden's own URLs.

1. **Register the app on GitHub** (Settings, Developer settings, GitHub Apps, New GitHub App), as a second app:
   - Homepage URL: this Warden's address.
   - Callback URL: this Warden's `/setup/github/write/callback`.
   - Setup URL: this Warden's `/setup/github/write`.
   - Leave "Request user authorization (OAuth) during installation" cleared, so GitHub sends you to the Setup URL
     after an install.
   - Webhook: clear "Active". The write app has no webhooks.
   - Repository permissions, these three and nothing else:
     - **Contents: Read and write**, to make the Fix PR's branch and commit its edit.
     - **Pull requests: Read and write**, to open the Fix PR and find one already open.
     - **Metadata: Read-only**, which GitHub requires for every app.
   - No account or organization permissions, and no Workflows. A Fix PR only edits `.claude/settings.json` or a
     `.mcp.json` file, never `.github/workflows/`. Warden refuses to link an installation that holds any other
     permission, or lacks one of these three.
   - Then generate a client secret and a private key. GitHub downloads the key as a `.pem` file named
     `<app-slug>.<YYYY-MM-DD>.private-key.pem`.
2. **Give Warden the keys.** The server reads `GITHUB_WRITE_APP_CLIENT_ID`, `GITHUB_WRITE_APP_CLIENT_SECRET` and
   `GITHUB_WRITE_APP_PRIVATE_KEY` (the `.pem` as downloaded), all three or none: with only some, it stops at start-up
   naming the missing or malformed ones. Then restart the server: it reads them when it starts.
   - Locally, the committed `.envrc` reads them from the keyring. Store each once, then `direnv reload`. The last
     command reads the key from the `.pem` GitHub downloaded: replace the placeholder path with that file's.

     ```sh
     secret-tool store --label "Warden GitHub write app client id" service warden-github-write-app-client-id
     secret-tool store --label "Warden GitHub write app client secret" service warden-github-write-app-client-secret
     secret-tool store --label "Warden GitHub write app private key" service warden-github-write-app-private-key < path/to/<app-slug>.<YYYY-MM-DD>.private-key.pem
     ```

   - On Cloud Run, the client secret and the private key live in Secret Manager as
     `warden-github-write-app-client-secret` and `warden-github-write-app-private-key`, read only by `warden-run` and
     `warden-preview-run`, never by a Scan Job. The client id goes in the repository variable
     `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` (public by design, as `WARDEN_GITHUB_APP_CLIENT_ID` is for the read app).
     Make both secrets, user-managed in `europe-west1` as the read app's are, then run `scripts/gcp-setup.sh` again:
     it grants them to those two accounts and prints the `gh variable set WARDEN_GITHUB_WRITE_APP_CLIENT_ID` line
     to run. Once the variable is set, the next release or owner preview passes the three settings to its revision,
     each secret pinned to a version; until then, it runs with Fix PRs off.
3. **Install and link it.** On Setup, choose **Install the write app**, and install it on the account or organization
   whose repos should get Fix PRs. GitHub sends you to the Grant write access page; choose **Sign in with GitHub**
   there. Setup then lists the grant under "Grant write access".

Only an Admin grants write access; a Lead or a Member sees "An Admin grants write access." and the Team's grant.

**On an owner preview,** add the preview's write callback URL to the write app too, keeping the live one, as
"Linking GitHub on a preview" says for the read app: `<preview URL>/setup/github/write/callback`. The write app's
Setup URL is the live dashboard's, so after an install note the `installation_id` in that address and open
`<preview URL>/setup/github/write?installation_id=<id>` on the preview.

## Turning on the agent hook

Guard records each developer's Claude Code sessions through a hook that Claude Code's managed settings turn on, on
every laptop. An Admin sets it up from Setup's "Agent hook" section; a Lead or a Member sees "An Admin turns on the
agent hook."

1. **Issue the token, and copy it at once.** Choose **Issue a hook token**. Setup shows the token this once, with
   **Copy token**: Warden keeps only its hash, so after a reload it's gone, and the only way to a new one is to rotate.
2. **Pick the Privacy tier.** Metadata sends tool names and outcomes; Details (the default) adds commands, file paths
   and URLs; Content adds tool output and prompts. The tier is the Team's, and Warden applies it to each event it
   stores.
3. **Copy the block into every laptop's managed settings.** Choose **Copy block**: while Setup still shows the token,
   the block holds it; otherwise it holds a placeholder for the token you copied. Paste it as Claude Code's managed
   settings file, which takes precedence over each developer's own settings:
   - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
   - Linux and WSL: `/etc/claude-code/managed-settings.json`
   - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`

   The block sends the laptop's `USER` as `X-Warden-Developer`: Warden stores only a pseudonym of it, never the name.
   Moving the tier to or from Content changes the block (Content adds the prompt event), so paste it again on every
   laptop after such a change.
4. **Rotate a token that leaked.** Choose **Rotate the hook token** and paste the new block. The token before it keeps
   working for 24 hours, so laptops can catch up. Rotating again inside those 24 hours stops that older token at once
   (Setup asks first): laptops that haven't got the current token stop sending.

## CVE data

Patch matches a Team's Products against a frozen snapshot of public CVE data, **as of 2026-10-13**. It ships in the
image (`server/src/modules/patch/cve-snapshot/`, copied byte for byte from Patch's own snapshot) and the loader puts
it in six Postgres tables (`cve_snapshot`, `cve_sources`, `cves`, `cve_kev`, `cve_epss`, `cve_osv`) that every Team
reads and the app can't change. Warden makes no outside call for CVE data: nothing is fetched from NVD, CISA, OSV or
FIRST while it runs, so the data stays as of that date until a release ships a newer snapshot.

| Source | Licence | Attribution |
|---|---|---|
| NVD CVE API 2.0 | Public (US government) | CVE records from the National Vulnerability Database (NIST) |
| CISA KEV 2026.10.08 | CC0 1.0 | CISA Known Exploited Vulnerabilities Catalog; no endorsement by CISA implied |
| OSV.dev | CC-BY 4.0 | Affected and fixed versions from OSV.dev, taken from GitHub Advisory Database records (CC-BY 4.0) |
| EPSS | Attribution requested by FIRST | EPSS by FIRST |

This product uses the NVD API but is not endorsed or certified by the NVD.

## Vouch

Vouch answers "Are we ready for the audit?" on the Overview: **Yes**, when every Control of each Catalogue on is
reviewed with no Gap; **Not yet**, with how many Gaps there are and how many Controls wait for a review; or, with no
Catalogue on, that Warden can answer once Vouch checks the Team's Controls.

**What it checks.** An Admin turns VDA ISA 2027.1 on in Setup. Vouch judges four of its Controls, 1.3.3, 1.3.4, 4.1.3
and 5.2.4, from the Team's Findings under each Control's Rules: the Rule-to-Control map (`RULE_CONTROLS` in the Vouch
module) names the Guard and Patch Rules behind 1.3.3, 1.3.4 and 4.1.3, and 5.2.4 reads the Judge's Spot runs. For each
Rule it reads Scan coverage on the Team's held Repo Assets (a Guard Rule) or Products (a Patch Rule) over the last 30
days, and the Open Findings on them, and gives each Control a Verdict, Evidenced, Partly evidenced or Not evidenced,
with a one-line reason and the Findings it cites. Severity doesn't change a Verdict, and Accepted and False positive
Findings don't count against one. The Verdict is worked out on each read, never stored.

**Reviews.** A Lead or an Admin confirms or overrides each Verdict from its Control's card; Not applicable is given
only by override, and an override needs a reason. Every review is kept in an append-only log. A Control whose
worked-out Verdict has moved since its review reads "Changed since review" and waits for a review again. A Gap is a
reviewed Control at Not evidenced or Partly evidenced. The Team is Audit-ready when a Catalogue is on and every one of
its Controls has been reviewed.

**No model call, no outside call.** Vouch calls no model and no outside service: the Catalogue ships in the server
image (`server/src/modules/vouch/vda-isa-2027.1/`) and is read from there at start-up.

**What it stores** (`docs/data.md`, the Vouch rows): the Catalogue's text with its source and licence, in the image;
each Team's Catalogue choices (`team_catalogues`); and the review log (`control_reviews`). A Team's choices and reviews
are kept for the life of the Team.

**Credit and licence.** VDA ISA 2027.1 is © 2026 ENX Association, licensed under CC BY-ND 4.0
(<https://creativecommons.org/licenses/by-nd/4.0/>). The full credit, the licence and how its text was taken from the
ISA Excel are in `NOTICE.md` in the Vouch module's `vda-isa-2027.1` folder.

## Checks

The fast lane (`.github/workflows/fast-lane.yml`) runs on every pull request into `main` or `spec/**`, and on push
to `main`:

| Check | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| eslint | `pnpm lint` |
| prettier | `pnpm format:check` (`pnpm format` fixes it) |
| `tsc --noEmit`, every package | `pnpm typecheck` |
| vitest, every package | `pnpm test` (the server's tests need a Postgres: they make a throwaway database there and drop it after; the `PGDATABASE` database is left alone. Locally, run them on a throwaway Postgres: see "Running the tests locally") |
| Browser tests (Chromium) | `pnpm e2e` (below) |
| Design lint | `pnpm design-lint` |
| Script tests | each `scripts/test/*.test.sh`, run with `bash` (the setup script's in `DRY_RUN=1` and against a fake `gcloud`: nothing reaches Google) |
| Image build | `docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=<key> .` |

**Running the tests locally.** Outside CI (`CI` unset), the server's tests and the browser tests refuse port 54329,
the compose Postgres that holds your own data, and stop before they connect, printing these steps. Run them on a
throwaway Postgres on a spare port instead, then stop it (`podman` takes the same arguments):

```sh
docker run -d --rm --name warden-test-postgres -p 127.0.0.1:55432:5432 -e POSTGRES_USER=warden \
  -e POSTGRES_DB=warden -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg17
PGHOST=127.0.0.1 PGPORT=55432 pnpm --filter @warden/server test
PGHOST=127.0.0.1 PGPORT=55432 pnpm e2e
docker stop warden-test-postgres
```

The global setups wait for the new container to take connections, so the tests can start straight after
`docker run`. To run against your own compose database on purpose, add `WARDEN_TEST_OWNER_DB=1` (exactly `1`):
`WARDEN_TEST_OWNER_DB=1 pnpm --filter @warden/server test`. CI runs its own Postgres service and sets `CI`, so it's
never refused.

**Browser tests.** `pnpm e2e` runs the Playwright tests in `e2e/` against the real server and a throwaway database.
They need a Postgres (as the server's tests do, and locally the throwaway one above) and Playwright's Chromium,
installed once with
`pnpm --filter @warden/e2e exec playwright install chromium`. No Clerk keys are needed, and none is read: the global
setup builds the dashboard in Vite's `e2e` mode, where a stand-in replaces `@clerk/react`, signs session tokens with a
key pair it makes, and starts the server with that key's public half as `CLERK_JWT_KEY`. It opens four Teams through
the API as their Admins: Acme and Bluebird filled with the demo seed; Cedar with only the Products tests' Products
and its two repos for the Setup tests; and Dahlia with one repo, a write grant and an Open Finding, for story 6's Fix
PR. It then drops the database when the tests end. A production build holds no part of the stand-in (a dashboard test checks).
`pnpm e2e e2e/products.spec.ts` runs only the spec files named, `pnpm e2e --ui` opens Playwright's UI, and a failed
test leaves its trace in `e2e/test-results/`.

The pre-push hook (`.githooks/pre-push`) runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
`pnpm design-lint`.

## Setting up Google Cloud

Warden runs on Cloud Run in `europe-west1`, with Cloud SQL for Postgres 17. `scripts/gcp-setup.sh` sets up the
project once. It's safe to run again: it creates only what's missing, and puts each setting back to the value it
sets. When Google's per-minute quota refuses a new service account (429), it waits as long as Google says, or a
minute, and tries again, up to 3 times.

**Before you run it** you need a Google Cloud project with billing, and on your machine:

- the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), signed in, with application-default
  credentials for the Cloud SQL Auth Proxy (`gcloud auth application-default login`). Their quota project must be
  this project, or unset: the proxy's calls are billed there, and another project refuses them. The script checks it
  first; to set it, run `gcloud auth application-default set-quota-project <project-id>`. A
  `GOOGLE_CLOUD_QUOTA_PROJECT` in your environment comes before it for the proxy, and `CSQL_PROXY_QUOTA_PROJECT`
  (the proxy's `--quota-project`) before both, so each must be this project too, or unset;
- the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy#install), `cloud-sql-proxy`, on
  your `PATH` (`gcloud components install cloud-sql-proxy` installs it);
- Node 24, and the server's dependencies installed (`pnpm install` in this repository): the script runs
  `server/src/roles.ts` itself.

And these, made by hand:

- a Cloud SQL for PostgreSQL 17 instance in `europe-west1`;
- the secrets `warden-db-password` (the instance's `postgres` user's password), `warden-clerk-secret`,
  `warden-clerk-publishable` and `warden-clerk-jwt-key`;
- the GitHub app's secrets `warden-github-app-client-secret` and `warden-github-app-private-key`, as #132's steps
  make them;
- optionally, the write app's secrets `warden-github-write-app-client-secret` and
  `warden-github-write-app-private-key` ("Granting write access" says how). The script checks them with the rest,
  before it changes anything. With both, it grants them to `warden-run` and `warden-preview-run` and prints the
  `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` variable's line. With neither, it carries on and says Fix PRs stay off until
  both are made and the script is run again. With only one, it stops, naming the missing one.

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
| Cloud SQL | the databases `warden` and `warden_preview`; daily backups, 7 kept; point-in-time recovery with 6 days of logs (Cloud SQL's docs ask for fewer log days than backups); no authorized networks, connectors required, and encrypted connections only (`--ssl-mode=ENCRYPTED_ONLY`) |
| Logging | the `_Default` log bucket keeps 30 days; Data Access audit logs (`DATA_READ`) for Secret Manager only, so each read of a secret is recorded |
| Secrets | `warden-db-app-password`, `warden-db-migrate-password`, `warden-db-admin-password`, `warden-db-preview-app-password` and `warden-db-preview-migrate-password`, each a random value piped straight into Secret Manager (never printed or written to a file), stored in `europe-west1` only. It then prints all eleven secrets' replication, and the write app's two when they exist |
| Database roles | run from your machine, as `postgres`, through the Cloud SQL Auth Proxy on a free local port: `server/src/roles.ts` makes the live roles (`warden_migrate`, `warden_app`, `warden_admin`) on `warden`, with their three passwords, then the preview roles (`warden_preview_migrate`, `warden_preview_app`, `warden_preview_admin`) on `warden_preview`, with the app and migrate passwords only: no preview Job runs as it, so `warden_preview_admin` can't log in. Each database lets only its own set connect. The passwords go from Secret Manager into that one process's environment only; the proxy is stopped when the script ends, also on failure. No service account reads the `postgres` password, so **rerun the script after a change to `createRoles`** |
| Service accounts | none has a key. See the table below |
| Workload Identity Federation | the pool `github` and its provider `warden`, which admits only the repository you name, by its numeric id, only a push or a manual dispatch, and only on its `main` and `preview/*` branches. The provider maps each token to its repository id and branch kind (`attribute.deploy`, such as `<repo-id>:main`): only this repository's `main` tokens may act as `warden-deploy`, and only its `preview/*` tokens as `warden-preview-deploy`, so a token from another repository can never match, even through another provider in the pool |
| The services and the job | Cloud Run services `warden` (as `warden-run`, at most 2 instances) and `warden-preview` (as `warden-preview-run`, at most 1 instance), each public with Google's placeholder image, and the Cloud Run job `warden-migrate-preview` (as `warden-preview-migrate`, with Google's placeholder job image). The script makes them because the deploy accounts can't make a service public, and `warden-preview-deploy`'s roles are on the preview service and job themselves. Run again, it puts each one's service account, instance limit and public access back, keeping the image it runs. Sign-in is Clerk's job |
| The daily Job and its trigger | the Cloud Run job `warden-daily-expiry` (as `warden-daily`, with Google's placeholder job image until a release gives it Warden's). The only account bound on the Job is `warden-scheduler` (`roles/run.invoker`, which holds `run.jobs.run`); accounts with `roles/run.developer` on the project, such as `warden-deploy`, and the project's owner can start it too, as Google's [Cloud Run IAM roles](https://docs.cloud.google.com/run/docs/reference/iam/roles) give each of them `run.jobs.run`. Then the Cloud Scheduler job `warden-daily-expiry` in `europe-west1`, which runs it daily at `0 4 * * *` (`Etc/UTC`, after the 03:00 backup) by a `POST` to the Job's `:run` URL with an OAuth token as `warden-scheduler`. Run again, it puts the Job's service account back, keeping its image, and updates the Scheduler job to these values. Cloud Scheduler is free for up to 3 jobs per billing account |
| The Scan Jobs | the Cloud Run job `warden-scan` (as `warden-scan`, with Google's placeholder job image until a release gives it Warden's), which the `warden` service starts once per Scan with the Scan's id and Team as its only override (ADR 0009). `warden-run` gets `roles/run.jobsExecutorWithOverrides` on this Job only: `roles/run.invoker` can't pass an override. Then the owner previews' Scan Job `warden-scan-preview` (as `warden-preview-scan`, the placeholder image until a preview gives it Warden's), which `warden-preview-run` may start with an override and `warden-preview-deploy` may update: the only roles bound on it. No preview account has a role on `warden-scan`. No live account is bound on `warden-scan-preview` either, but `warden-deploy`'s `roles/run.developer` on the project reaches it, as it reaches the daily Job: it can start and update it (`run.jobs.run`, `run.jobs.update`), and the project's owner can too. This is accepted (threat model, R3): `warden-deploy` already updates every live Job, and narrowing its role would mean binding it Job by Job. Run again, it puts each Job's service account back, keeping its image. An existing project gets the Jobs and their accounts by running the script again |

**The service accounts and what each may do:**

| Account | Used by | May |
|---|---|---|
| `warden-run` | the `warden` service | Cloud SQL client; read `warden-db-app-password`, `warden-clerk-secret`, `warden-clerk-jwt-key`, `warden-github-app-client-secret` and `warden-github-app-private-key` (it and `warden-preview-run` are the only accounts that read the GitHub app's client secret, which signs people in); when they exist, `warden-github-write-app-client-secret` and `warden-github-write-app-private-key`, for Fix PRs; start `warden-scan` with an override (`roles/run.jobsExecutorWithOverrides` on that Job only) |
| `warden-migrate` | the live migration job | Cloud SQL client; read `warden-db-app-password` and `warden-db-migrate-password`. Not the `postgres` password |
| `warden-daily` | the daily expiry Job `warden-daily-expiry` (the setup script makes it; each release updates its image) | Cloud SQL client; read `warden-db-app-password` and `warden-db-admin-password`. The only account that reads the admin password, so the server can't list Teams |
| `warden-scan` | the Scan Job `warden-scan` (the setup script makes it; each release updates its image) | Cloud SQL client; read `warden-db-app-password` and `warden-github-app-private-key`, to read the Team's repos as the GitHub app. Never the admin password: it works inside one Team and lists none. Never the GitHub app's client secret, so it can't sign anyone in to GitHub |
| `warden-deploy` | GitHub Actions on `main` | Cloud Run developer on the project; writer on the `warden` repository; act as `warden-run`, `warden-migrate`, `warden-daily` and `warden-scan`. Reads no secret |
| `warden-preview-run` | the `warden-preview` service | Cloud SQL client; read `warden-db-preview-app-password`, `warden-clerk-secret`, `warden-clerk-jwt-key`, `warden-github-app-client-secret` and `warden-github-app-private-key` (as `warden-run` does: previews share the live read-only GitHub app); when they exist, the write app's `warden-github-write-app-client-secret` and `warden-github-write-app-private-key` (previews share the live write app too); start `warden-scan-preview` with an override (on that Job only) |
| `warden-preview-migrate` | the `warden-migrate-preview` job | Cloud SQL client; read `warden-db-preview-migrate-password` only |
| `warden-preview-scan` | the preview Scan Job `warden-scan-preview` (the setup script makes it; each preview updates its image) | Cloud SQL client; read `warden-db-preview-app-password` and `warden-github-app-private-key`. Never a live password, the admin password or the GitHub app's client secret |
| `warden-preview-deploy` | GitHub Actions on `preview/*` | Cloud Run developer on the `warden-preview` service and the `warden-migrate-preview` and `warden-scan-preview` jobs only, never the project; writer on the `warden-preview` repository only; act as `warden-preview-run`, `warden-preview-migrate` and `warden-preview-scan` only. Reads no secret |
| `warden-scheduler` | Cloud Scheduler | start `warden-daily-expiry` (`roles/run.invoker` on that Job), nothing else; reads no secret. The only account bound on the Job; `roles/run.developer` on the project (`warden-deploy`) and the project's owner also hold `run.jobs.run` |

Previews still share the one Clerk secret key with live for now, and the read-only GitHub app's two secrets (#275):
code on a preview branch can read every installation of that app, as the live service can (`docs/threat-model.md`,
R3).

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
   credentials, the instance and the six secrets above, and stops naming any that's missing. It checks the write
   app's two optional secrets too: both or neither, as above, and it stops naming the missing one when only one is
   there. A `gcloud` error
   other than "not found" also stops it, printing the error, and so does a failed roles run, with the roles
   script's own error (which holds no password). Turning on point-in-time recovery restarts the instance once
   (Cloud SQL's docs say so), closing open connections; the script warns first, and skips that flag when it's
   already on.

4. Paste the `gh variable set` lines it prints last. They hold names and ids only, never a secret:
   `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `GCP_PREVIEW_DEPLOY_SA` (the preview workflow's
   account), `CLOUD_SQL_CONNECTION`, `VITE_CLERK_PUBLISHABLE_KEY` and `WARDEN_GITHUB_APP_CLIENT_ID` (the GitHub
   app's client id; GitHub refuses a variable name that starts with `GITHUB_`, and the release hands it to the live
   service as `GITHUB_APP_CLIENT_ID`). The publishable key and the client id are public by design; their lines read
   them from your keyring when you paste them. With both write-app secrets in Secret Manager, it also prints
   `WARDEN_GITHUB_WRITE_APP_CLIENT_ID`'s line, the write app's client id, which switches Fix PRs on at the next
   release or preview; without them it prints a note in its place, and Fix PRs stay off:

   ```sh
   gh variable set VITE_CLERK_PUBLISHABLE_KEY --body "$(secret-tool lookup service warden-clerk-publishable)" --repo <owner>/<repo>
   gh variable set WARDEN_GITHUB_APP_CLIENT_ID --body "$(secret-tool lookup service warden-github-app-client-id)" --repo <owner>/<repo>
   gh variable set WARDEN_GITHUB_WRITE_APP_CLIENT_ID --body "$(secret-tool lookup service warden-github-write-app-client-id)" --repo <owner>/<repo>
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
   repository variables `GCP_PROJECT_ID`, `GCP_PREVIEW_DEPLOY_SA`, `GCP_WIF_PROVIDER`, `CLOUD_SQL_CONNECTION`,
   `VITE_CLERK_PUBLISHABLE_KEY` and `WARDEN_GITHUB_APP_CLIENT_ID` must be set. Without `GCP_PROJECT_ID` or `GCP_PREVIEW_DEPLOY_SA`, the run deploys
   nothing and stays green, with a notice naming every missing variable. With those two but another missing, it
   fails, naming each. `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` is optional, and not checked: see step 6.
2. **Build** the image, with no Google credentials.
3. Sign in to Google Cloud through Workload Identity Federation (no key) as `warden-preview-deploy`, and push the
   image to the `warden-preview` repository, tagged with the commit.
4. **Migrate:** first check that the preview Scan Job `warden-scan-preview` exists; if it doesn't, the run fails
   before anything changes (rerun `scripts/gcp-setup.sh`). Then deploy the `warden-migrate-preview` job with the
   image, as `warden-preview-migrate`, run `node server/src/migrate.ts`, then the CVE snapshot loader
   `node server/src/modules/patch/cve-snapshot.ts`, on `warden_preview` in one execution, and wait for it. A failed
   migration or load stops the deploy before any revision exists.
5. **The Scan Job:** `warden-scan-preview` gets the image and its settings afresh, as a release does for
   `warden-scan`, but as `warden-preview-scan` on `warden_preview` as `warden_preview_app`, with the preview app
   password and the GitHub app's private key, both pinned (never its client secret). It comes before the revision, so
   the revision's first Scan runs this image. If this fails, the run fails naming the Job and no revision is deployed:
   push again.
6. **Deploy:** a `warden-preview` revision named `warden-preview-pre-<name>-<sha7>-<run>-<attempt>`, as
   `warden-preview-run`, tagged `<name>`, with **no traffic**. Every run sets the revision's env vars and secrets
   afresh, so none carries over from an earlier revision. Its `WARDEN_SCAN_JOB` names
   `projects/<project-id>/locations/europe-west1/jobs/warden-scan-preview`, which "Scan now" and a GitHub link start,
   and it gets the read-only GitHub app's settings as a release does: `GITHUB_APP_CLIENT_ID` from the repository
   variable, and the secrets `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY`, pinned. When the optional
   repository variable `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` is set, it also gets the write app's, which switch Fix PRs
   on: `GITHUB_WRITE_APP_CLIENT_ID` from it, and the secrets `GITHUB_WRITE_APP_CLIENT_SECRET` and
   `GITHUB_WRITE_APP_PRIVATE_KEY`, pinned (previews share the live write app). Unset or empty, it gets none of the
   three and runs with Fix PRs off. The Scan Job (step 5) never gets the write app's.
7. **Health gate:** call `/api/health` on the tag's URL for up to about 90 seconds (a cold start) until it answers
   200, or fail the run. When the deploy (step 6) or the health gate fails, `warden-scan-preview` already runs this
   image (step 5), and the run says so: every preview's Scans run it until you push a working preview again.

**One Scan Job for every preview.** All previews share `warden-scan-preview`, which runs the image of the last
preview deployed. Two previews of different code side by side both start Scans on the last-deployed one's image.
That holds for a preview that failed at its deploy or its health gate too: the Job keeps its image, and every
preview's Scans run it, until a working preview is pushed.

**One at a time.** Previews share the database, so steps 3 to 7 run for one preview at a time, and a running one is
never cancelled halfway. Builds run side by side. While one preview deploys, GitHub keeps only the newest waiting
behind it: an older waiting preview is cancelled (the run shows it) and must be pushed again.

**Its URL** is `https://<name>---warden-preview-<project-number>.europe-west1.run.app`, the same for every push to
the branch. The run prints it at the end of the deploy step's log and on the run's summary page: open that one, and
register that one on the GitHub app (below). Cloud Run also gives the revision a second, hashed URL; it serves the
same revision, but its callback isn't registered, so linking GitHub fails there. Sign-in uses Clerk's development
instance.

**Linking GitHub on a preview.** Previews share the live read-only GitHub app. Its sign-in sends GitHub the page's
own origin plus `/setup/github/callback` as `redirect_uri`, and GitHub refuses one that isn't among the app's
callback URLs with `redirect_uri_mismatch`. GitHub's docs don't say where a GitHub App's refusal lands: it may show
on GitHub, or on one of the app's registered callback pages (the live dashboard's or a preview's), which says
"GitHub refused the sign-in (redirect_uri_mismatch)". So, once per preview name, add that preview's callback URL to
the app (GitHub, Settings, Developer settings, GitHub Apps, the app, "Callback URL", "Add
Callback URL"), keeping the live one. The Ready preview's default name is `guard`:

```text
https://guard---warden-preview-<project-number>.europe-west1.run.app/setup/github/callback
```

The app has one Setup URL, the live dashboard's, so GitHub sends you there after an install even when you started on a
preview. Note the installation id in that address (`installation_id=<id>`), then open
`<preview URL>/setup/github?installation_id=<id>` on the preview and sign in there. A repo linked on a preview is
read into `warden_preview` only.

**Secrets are pinned.** The revision and the jobs read their passwords and keys from Secret Manager by version
number, never `latest`. The numbers live in `secret_version` in `scripts/lib/cloud-run.sh`. To move one: add the
new version (`gcloud secrets versions add <secret> --data-file=-`), change its number there in a PR, merge it, then
push a preview. Disable the old version only after no running revision reads it.

**Logs:** the workflow run on GitHub (Actions, "Preview"); the migration job's and the Scan Job's executions
(`gcloud run jobs executions list --job warden-migrate-preview --region europe-west1`, and the same for
`warden-scan-preview`) and their logs; and the
revision's own logs in Cloud Logging
(`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="warden-preview"'`).
Warden's request lines hold no address, except on a refused sign-in (`clientAddress`, the address the sign-in limit
counted).

The preview's data stays in `warden_preview`: seed it as "Local setup" shows. Old tags and revisions aren't cleaned
up yet.

## Releasing

Every merge to `main` releases Warden to the live `warden` service. It needs Google Cloud set up first (above), with
the repository variables `GCP_PROJECT_ID`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER`, `CLOUD_SQL_CONNECTION` and
`VITE_CLERK_PUBLISHABLE_KEY`. Without any of the five, a release deploys nothing and the run stays green, with a
notice naming each missing variable (a rollback needs the first four). A release also needs
`WARDEN_GITHUB_APP_CLIENT_ID`: without it, the release fails naming it after the image is pushed to Artifact Registry,
before anything is migrated or deployed. A rollback needs it too, for the Scan Job: without it, the rollback fails
naming it before it changes anything. `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` is optional: set, a release switches Fix
PRs on (step 4); unset or empty, the release runs with Fix PRs off.

**What a release does** (`.github/workflows/release.yml`, then `scripts/cloud-run-deploy.sh <image> release`):

1. **Full lane:** every test in every browser (`full-lane.yml`, called through `workflow_call`). A red full lane
   releases nothing.
2. **Build** the image, then sign in to Google Cloud through Workload Identity Federation (no key) as
   `warden-deploy`, and push it to the `warden` repository as
   `europe-west1-docker.pkg.dev/<project-id>/warden/warden:<commit>`.
3. **Migrate:** first check that the Scan Job `warden-scan` exists; if it doesn't, the release fails before anything
   changes (rerun `scripts/gcp-setup.sh`). Then deploy the `warden-migrate` job with the image, as `warden-migrate`,
   run `node server/src/migrate.ts`, then the CVE snapshot loader `node server/src/modules/patch/cve-snapshot.ts`, on
   `warden` as `warden_migrate` in one execution, and wait for it. A failed migration or load stops the release
   before any revision exists.
4. **Deploy:** a `warden` revision named `warden-rel-<sha7>-<run>-<attempt>`, as `warden-run`, tagged `candidate`, with **no
   traffic**. Every release sets the revision's env vars and secrets afresh; its `CLERK_AUTHORIZED_PARTIES` is each
   URL Cloud Run gives the service, and its `WARDEN_SCAN_JOB` names the Scan Job
   (`projects/<project-id>/locations/europe-west1/jobs/warden-scan`), which "Scan now" starts. Linking a GitHub
   installation starts it too, for the first Scan of the linked repos, and uses one of the Team's hourly Scans; the
   link answers once the Job has started, which can take up to about 20 seconds. It also gets the GitHub app's
   settings: `GITHUB_APP_CLIENT_ID` from the repository variable, and the secrets `GITHUB_APP_CLIENT_SECRET` and
   `GITHUB_APP_PRIVATE_KEY`, pinned. With the optional repository variable `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` set, it also
   gets the write app's, for Fix PRs: `GITHUB_WRITE_APP_CLIENT_ID` from it, and the secrets
   `GITHUB_WRITE_APP_CLIENT_SECRET` and `GITHUB_WRITE_APP_PRIVATE_KEY`, pinned; without it, none of the three. A
   preview's revision gets the same, naming `warden-scan-preview` instead (see "Owner previews"). A revision with no Scan Job starts no Scan when an installation is linked.
5. **Health gate:** call `/api/health` on the tag's URL (`https://candidate---warden-<project-number>.europe-west1.run.app`)
   for up to about 90 seconds until it answers 200. If it never does, the release fails and the revision gets no
   traffic.
6. **The Scan Job:** `warden-scan` gets the same image and its settings afresh (`node server/src/scan-job.ts`, as
   `warden-scan`, one retry, a task timeout of an hour, the app password and the GitHub app's private key, both
   pinned, and the app's client id as `GITHUB_APP_CLIENT_ID`; never its client secret), before any traffic moves, so
   the revision that takes the traffic never starts a Job still on an older image. If this step fails, the release
   fails with no traffic moved: dispatch it again.
7. **Traffic:** 100% of the service's traffic to that revision, by its name. The same call tags the release it took
   the traffic from `previous` (a tag moves no traffic), which is where a rollback goes by default. So only a
   revision that served is ever tagged `previous`: one whose health gate failed never is. When the revision it took
   the traffic from isn't a release (Google's placeholder before the first release, or after a rollback by hand), the same call removes the
   `previous` tag instead, so a rollback never goes to a stale release.
8. **The daily Job:** `warden-daily-expiry` gets the same image and its settings afresh (`node
   server/src/daily-expiry.ts`, as `warden-daily`, one retry, its two passwords pinned), so both Jobs and the service
   run the same code. The Cloud Scheduler job that starts it isn't changed. If this step fails, the run fails after
   the traffic has moved, naming the Job: dispatch the release again, or set the image by hand (below).

**One at a time, and never backwards.** Only the deploy job (steps 2 to 8) holds the `release` lock; full lanes run
side by side. (GitHub applies a called workflow's `concurrency` with the caller's context, so `full-lane.yml` and the
`fast-lane.yml` it calls give each called run a group of its own, the release run's id: one group for every merge
would queue them.) A running deploy is never cancelled. While one runs, GitHub keeps only the newest waiting behind it: an
older waiting one shows as cancelled. Since full lanes finish in any order, the deploy script first compares this
commit with the serving release's (the `<sha7>` in its `warden-rel-` name, looked up in `main`'s history, which the
workflow checks out whole):

- this commit isn't on `main`: the run fails, before anything changes;
- a release of a newer commit is serving: the run skips, exits green, and says so;
- a release of this same commit is serving (a re-run after step 8 failed): only the two Jobs, `warden-scan` and
  `warden-daily-expiry`, are set (steps 6 and 8);
- otherwise (an older release serves, or a revision that isn't a release, or one whose commit isn't in the
  history): it releases. So a good commit still releases when a newer one never does (its full lane failed, or it
  skipped CI).

To release again without a merge (to retry a failed one), run "Release" by hand from `main`
(`gh workflow run release.yml --ref main`), or re-run the failed run: the revision name ends in the run's attempt,
so a re-run makes a new revision.

**Releases and rollbacks.** A rollback has its own lock (`rollback`), so a waiting rollback and a waiting release
never cancel each other, and the two can run at the same time. A rollback reads the serving revision when it starts
(and with `from`, stops if it isn't that one), then again just before it moves the traffic: if a release moved the
traffic meanwhile, it stops with traffic unchanged, and you dispatch it again if it's still wanted. A release that
starts after a rollback moved the traffic releases forward from it, as any merge to `main` does.

Secrets are pinned as for previews: see "Secrets are pinned" in "Owner previews" above. The live service reads
`warden-db-app-password`, `warden-clerk-secret`, `warden-clerk-jwt-key`, `warden-github-app-client-secret` and
`warden-github-app-private-key`, and the write app's `warden-github-write-app-client-secret` and
`warden-github-write-app-private-key` when `WARDEN_GITHUB_WRITE_APP_CLIENT_ID` is set; the migration job
`warden-db-migrate-password`; the daily Job `warden-db-app-password` and `warden-db-admin-password`; the Scan Job
`warden-db-app-password` and `warden-github-app-private-key`, never the client secret nor either of the write
app's. A new version
reaches them with the next release after the PR that moves its number.

**Roll back** with the "Rollback" workflow, by hand from `main`, which runs `scripts/cloud-run-rollback.sh
[revision]`. **During an incident, name both revisions**: the one to go back to, and the one you saw serving. Then
nothing changes if a release lands before the rollback starts:

```sh
gh workflow run rollback.yml --ref main -f revision=<revision to go back to> -f from=<revision serving now>
```

With no `revision`, it goes back to the release tagged `previous` (step 7 above). In order, it:

1. tags the revision `rollback` and waits for `https://rollback---warden-<project-number>.europe-west1.run.app/api/health`
   to answer 200. If it never does, it stops there and traffic stays where it is;
2. reads the serving revision again, and stops with traffic unchanged if a release moved it meanwhile; otherwise
   moves 100% of `warden`'s traffic to it, by name;
3. gives `warden-daily-expiry` that revision's image by its digest (the one Cloud Run resolved when it deployed the
   revision, not the movable `:<commit>` tag), with the Job's whole configuration set afresh by the same function a
   release uses (`update_daily_job` in `scripts/lib/cloud-run.sh`), so with today's pinned secret versions; then
   gives `warden-scan` the same digest, the same way (`update_scan_job`). If either fails, the run fails after the
   traffic has moved, naming the Job;
4. checks that the service's own `/api/health` answers 200, and fails the run otherwise.

It fails before changing anything when no release is tagged `previous` (or that one is already serving, as after a
rollback), when traffic is split and no revision is named, when the named revision isn't a release (`warden-rel-…`;
Google's placeholder `warden-00001-…` answers 200 anywhere but can't run the daily Job), when the revision isn't one
of `warden`'s, or when the serving revision isn't the `from` one. To roll back by hand instead:

```sh
gcloud run revisions list --service warden --region europe-west1
gcloud run services update-traffic warden --to-revisions=<revision>=100 --region europe-west1
gcloud run revisions describe <revision> --region europe-west1 --format='value(status.imageDigest)'
gcloud run jobs update warden-daily-expiry --image=<that digest> --region europe-west1
gcloud run jobs update warden-scan --image=<that digest> --region europe-west1
```

**The schema stays.** Migrations only run forwards, so a rollback keeps the newer schema, and the earlier code runs
against it. The next merge to `main` releases forward again.

**Run the daily Job by hand:** `gcloud run jobs execute warden-daily-expiry --region europe-west1 --wait`. Cloud
Scheduler runs it daily at 04:00 UTC; `gcloud scheduler jobs run warden-daily-expiry --location europe-west1` starts
that trigger now.

**Logs:** the workflow runs on GitHub (Actions, "Release" and "Rollback"); the migration job's and the daily Job's
executions (`gcloud run jobs executions list --job warden-migrate --region europe-west1`, and the same with
`--job warden-daily-expiry` or `--job warden-scan`) and their logs; and the service's own logs in Cloud Logging
(`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="warden"'`).
