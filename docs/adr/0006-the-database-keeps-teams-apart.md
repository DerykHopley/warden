# The database keeps Teams apart

Every Team-owned table has Postgres row-level security. Each request and each background job runs in a
transaction that sets its Team, and the policies only show and accept that Team's rows. The app connects as a role
that can't bypass them. A query that forgets the Team still can't reach another Team's data.

## How

- **`withTeam(team, async (tx) => …)`** is the only way request and job code gets a database handle. It opens a
  transaction and sets the Team for that transaction only, so a pooled connection carries nothing into its next use.
- **No Team set means no rows:** reads return nothing and writes are refused.
- **Policies on every Team-owned table, read and write,** with row-level security forced so the table owner is bound
  too. A CI check fails when any table lacks it.
- **Separate roles:** the app role (bound by the policies), a migration role, and an admin role for the few
  deliberate cross-Team tasks (the dev page's totals), used from one marked place in the code.
- **Foreign keys include the Team:** `(team_id, id)`, because Postgres checks foreign keys without the policies,
  and a plain key would let Team A point at Team B's rows and learn they exist.
- **Fields people filter on are real columns**, not JSON: a JSON filter lost its index under the policies.
- **Vector search sets `hnsw.iterative_scan`:** without it, an HNSW search under the policies returned 1 to 6 of
  10 results (nothing leaked; results went missing).
- **LangGraph thread ids carry the Team** and are checked before a resume: the checkpointer's own tables have no
  Team column.

## Why

A security product should be able to say a forgotten filter can't leak. Two designs were spiked against the same
12 attack cases (2026-11-24): an app-level filter (13/13) and row-level security (14/14). Both kept Teams apart, but
the app filter only holds while every query goes through its helper: code that got around it read every Team.
Row-level security moves the risk from every query to every new table, and a CI check covers that. The thin
`withTeam` helper keeps the app's code simple; the app filter's table-swapping trick, which leaned on query-builder
internals, isn't needed.

Spike code and cases: the capstone archive, `architecture/spikes/team-scoping/`.

## Consequences

- **On Cloud SQL, what's known before the first deploy:**
  - Where the user running `roles` can't grant `BYPASSRLS` (Cloud SQL's `postgres`), `warden_admin` is made
    without it, with a warning. There it's bound by the policies like `warden_app`, so `withAdmin` can't cross
    Teams.
  - `checkDatabaseRole` refuses `warden_admin` and `warden_migrate`, and any role that can become them, by name, at
    start and on each new connection (#16, #17); also their preview twins, and an app role that is a member of any
    role (#32).
  - Owner previews have their own three roles (`warden_preview_migrate`, `warden_preview_app`,
    `warden_preview_admin`) on the `warden_preview` database. Roles belong to the whole instance, so each database
    lets only its own set connect: `createRoles` takes CONNECT away from PUBLIC (#32).
  - No service account reads `postgres`'s password: the setup script runs `roles` for both sets from the owner's
    machine, through the Cloud SQL Auth Proxy, and the migration jobs run only migrations (#32). Whether `postgres`
    may revoke PUBLIC's CONNECT on a database `gcloud` made (it belongs to `cloudsqlsuperuser`) is checked by
    `createRoles` itself, which stops if PUBLIC can still connect.
  - What the first deploy must still show live: `warden_app`'s attributes on Cloud SQL, and `warden_admin`'s
    outcome, which #24 records.
- An empty result can mean "no Team set" as well as "nothing there": tests assert the Team is set, and `withTeam`
  refuses an empty Team.
- The local-first desktop app holds one Team, so it doesn't need the policies; it keeps the same `withTeam` shape.
