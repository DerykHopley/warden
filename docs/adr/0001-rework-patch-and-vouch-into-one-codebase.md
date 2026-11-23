# Rework Patch and Vouch into one Warden codebase

Warden is one product with three modules (Guard, Patch, Vouch). Patch and Vouch were separate sprint apps on the
same stack (FastAPI, React, Clerk, Cloud Run). We rework both into this one codebase instead of running them as
services behind a Warden shell, so there is one dashboard, one Finding format, one chat agent with tools from all
three modules, and one deploy. The rework also makes Warden's own design visible, not two copied apps.

## Consequences

- The goal is all of Patch and Vouch, ported in pieces (order in the capstone IDEAS.md, round 7).
- Patch's and Vouch's chats merge into one LangGraph agent; their dev pages merge into one.
- Patch's per-user watchlist becomes Team Products; its access requests become Clerk Organizations.
