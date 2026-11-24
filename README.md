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
   ```

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
   the server. Open http://localhost:5173.

The server checks its configuration at start-up and stops, naming the variable, when a required one is missing.
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
| Image build | `docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=<key> .` |

The pre-push hook (`.githooks/pre-push`) runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
`pnpm design-lint`.

## The image

`Dockerfile` builds the dashboard (it needs `VITE_CLERK_PUBLISHABLE_KEY` as a build argument and fails without it)
and runs the server as the non-root `node` user on `PORT`. The server reads the same variables at run time.
