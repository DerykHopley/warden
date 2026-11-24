# Warden collects Agent events through its own hook

Guard's Judge reads Agent sessions. Warden receives their Agent events itself, through a Claude Code `http` hook
an admin sets in managed settings, rather than reading them from a Team's Langfuse project as first planned.

## Why

Research on 2026-11-24 (capstone archive, `research/research-agent-session-traces-into-langfuse/`) found:

- Small teams rarely collect agent sessions. Every built-in way to see session content is opt-in per developer or
  limited to Enterprise plans (Anthropic's Team dashboard shows counts only; Cursor and Copilot content export are
  Enterprise-only).
- Claude Code's telemetry fits Langfuse poorly: Langfuse takes traces only and has no logs endpoint, while Claude
  Code's per-event detail is in its logs and its traces are a beta.
- Claude Code hooks are documented; an `http` hook posts each event to a URL with nothing installed on the laptop,
  and a managed hook can't be switched off by a developer. Langfuse's own Claude Code integration is a hook too.

## How

- **One endpoint, a token per Team.** The hook's token names the Team; the endpoint refuses events without one.
- **Privacy tier** decides which content Claude Code includes (Metadata, Details or Content; Details by default).
- **Redact on arrival, always.** Where a laptop runs safeagents, its `scrub` cleans events before they leave.
- **Judge, then drop.** Agent events are kept only until judged, and at most 7 days. Every Agent session keeps a
  record without content (Team, pseudonymous developer, agent, times, judged or not, outcome), which is the evidence
  for ISA2027 5.2.4 that logs are checked. A flagged session's Finding keeps only the masked events the Judge used
  and a hash of what it saw.
- **Claude Code first.** Other agents (Codex, Copilot, Gemini CLI, Cursor) come later behind the same endpoint.
- **Langfuse stays** for tracing Warden's own model calls, and may later become an optional import.

## Considered options

- **Read each Team's Langfuse project:** most small teams don't have one, and setup is per developer.
- **Both a hook and a Langfuse reader from the start:** two ingestion paths to build and test before the deadline.

## Consequences

- Warden now holds sensitive data in transit, so the endpoint, its tokens and retention are in the threat model
  (`docs/threat-model.md`, a foundation spec slice) and `docs/data.md`.
- The eval's scripted sessions reach Warden through the same hook.
- Hook tokens are secrets: kept in Secret Manager, rotatable per Team.
