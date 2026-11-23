# One Postgres with pgvector, in place of ChromaDB

Warden keeps all its data in one Postgres database (its own Cloud SQL instance), with pgvector for search.
Patch used ChromaDB, but only in its `rag/` search; Vouch already used Postgres and the LangGraph Postgres
checkpointer. One database means one backup, one access model per Team, and joins between Findings, Verdicts and
evidence. Agent traces stay in Langfuse Cloud; evidence for a flagged Agent session is copied into Postgres, since
Langfuse's free tier keeps data only for a limited time. Large files stay in Cloud Storage.

## Considered Options

- Keep ChromaDB beside Postgres: two stores to run and keep in step, for search alone.
- Self-host Langfuse: brings its own Postgres, ClickHouse and Redis.
