# TypeScript end to end

Warden's server is TypeScript, like its dashboard, so the whole product is one language with one set of types
from the database to the screen. This reverses the 2026-11-23 choice of a Python FastAPI server.

Warden is its own product, not a copy of Patch and Vouch, so consistency weighs more than reusing their
Python. Patch and Vouch are reworked into Warden's modules either way (ADR 0001): a Python port would still
split Vouch's 2,869-line `api.py` and 1,753-line `database.py`. So the extra cost of TypeScript is the
translation, and a stack spike (2026-11-24) showed that cost is small and faithful:

- **Reconcile seam** ported to TypeScript: 28/28 tests. The type checker caught what Python wouldn't: a new
  Status fails the build at every place that doesn't handle it.
- **Patch verdict and priority** ported with all 102 tests, green on the first run; 251 real OSV versions
  compared across both languages with no mismatch.
- **LangGraph.js** does what Vouch's graph and chat use: approval interrupt, resume from Postgres in a new
  process, streaming, view tools vs change tools, pgvector (12/12 tests).

Spike code and notes: the capstone archive, `architecture/spikes/stack-ts/`.

## Stack

| Layer | Was (Python) | Now |
|---|---|---|
| Server | FastAPI | Hono on Node 24 |
| Schemas and validation | Pydantic | zod: one schema gives the type, API checks and the queued job payload, shared with the dashboard |
| Agents | LangGraph (Python) | LangGraph.js, Postgres checkpointer |
| Tests | pytest | vitest |
| Lint and format | ruff | eslint and prettier (eslint carries the module-boundary rule in ADR 0005) |
| Database access | psycopg | Kysely over `pg`, with plain SQL migration files (row-level security, policies and `(team_id, id)` keys are hand-written SQL, ADR 0006) |
| Repo layout | two repos | pnpm workspaces: `server`, `dashboard`, `contracts` (zod schemas, JSON Schema, reconcile cases) |

Unchanged: React dashboard, Clerk, Postgres with pgvector, Cloud Run, Langfuse Cloud, OpenRouter.

## Consequences

- **The dashboard and server share one package of zod schemas** (Finding v1, view state, API bodies). The
  view-state contract needs no generated types or matching test.
- **Audit rows are written after the checkpoint commits, and idempotently.** The LangGraph.js Postgres saver
  runs its own transaction, so a checkpoint can't share one with the app's rows the way Vouch's review did.
- **Asset identity needs a string key** (`kind:ref`) in every Set and Map: TypeScript has no value equality, and
  forgetting it compiles. The Findings module hides this behind its interface.
- **Version matching uses `@renovatebot/pep440` and `semver`,** with a pad so `1.2` reads as `1.2.0` (npm `semver`
  has no loose option for it). Patch's version tests come across as they are.
- **Evals move to TypeScript.** Vouch's DeepEval faithfulness checks are Python: they are redone, and running
  them is a paid run, asked for first.
- **One exception: the desktop app is Rust (Tauri),** local-first and its own spec (owner, 2026-11-24). Its pages are
  the website's, in TypeScript; its native side is Rust. So the shared schemas also publish JSON Schema, and the
  reconcile cases are data files, so a Rust implementation can be held to the same contracts.
- **Rig's tooling scripts** (`scripts/ticket-lint.py`, `scripts/design-lint.py`) stay Python: they're rig's, not
  Warden's product code.

## Considered options

- **Stay on Python:** reuse more of Patch's and Vouch's code with less translation; two languages and two sets
  of types, joined by generated types.
- **Biome instead of eslint and prettier:** faster, but the import-boundary rule ADR 0005 relies on is an eslint rule.
- **Drizzle instead of Kysely:** has migrations built in, but they'd fight the hand-written RLS SQL; Kysely was what the scoping spike proved.
- **TypeScript with Effect:** typed errors, layers and retries fit the seams, but it's a second learning curve
  on top of TypeScript, it spreads through every caller, and LangChain.js returns plain promises. Left for later.
